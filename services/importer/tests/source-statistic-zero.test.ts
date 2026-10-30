import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { convertVndb } from '@rezics/conversion/vndb';
import { Importer } from '../src/importer.ts';
import { createImportTransport } from '../src/import-client.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const subject = '00000000-0000-4000-8000-000000000101';
const registration = createSourceRegistration('vndb');
function record(count?: number, average?: number | null): SourceRecord {
  return {
    source: 'vndb',
    key: 'v123',
    revision: '7',
    payload: {
      vn: {
        id: 'v123',
        olang: 'en',
        ...(count === undefined ? {} : { c_votecount: count }),
        ...(average === undefined ? {} : { c_average: average }),
      },
      entry_meta: { id: 'v123', revision: 7 },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Visual novel', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}
function convert(row: SourceRecord) {
  return registration.convert(
    { external_id: row.key, record_revision: row.revision!, record: row.payload },
    { source: 'vndb' },
  );
}

test('only sanitized explicit VNDB zero produces removal without changing converter identities', () => {
  for (const average of [null, 0]) {
    const row = record(0, average);
    const converted = convert(row);
    const native = convertVndb(
      { external_id: row.key, record_revision: row.revision!, record: row.payload },
      { source: 'vndb' },
    );
    expect(converted.sourceStatisticClear).toEqual({
      source: 'vndb',
      sourceRecordId: 'v123',
      count: 0,
      asOf: '2026-10-25',
    });
    expect(converted.sourceStatistic).toBeUndefined();
    expect(converted.digest).toBe(native.digest);
    expect(converted.normalized).toEqual(native.normalizedRecord);
    expect(converted.proposals).toEqual(native.proposals);
  }
  for (const row of [record(), record(10, null), record(10, 0)]) {
    expect(convert(row).sourceStatisticClear).toBeUndefined();
    expect(convert(row).sourceStatistic).toBeUndefined();
  }
  expect(() => convert(record(0))).toThrow('supplied together');
  expect(() => convert(record(undefined, null))).toThrow('supplied together');
});

// Local protocol doubles: production adapter, transport, bounded coordinator and durable journal.
// Native authorization, receipts and effects are covered by the adjacent kernel journey.
async function fixture() {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp('.temp/source-zero-');
  let failure: 'lost' | 'denied' | null = null;
  let fenced = false;
  const writes: { method: string; bytes: string; key: string | null }[] = [];
  const batches: BatchWriteRequest[] = [];
  let candidate = 0;
  const transport = createImportTransport({
    origin: 'https://zero.import.test',
    tokenProvider: async () => 'local-protocol-token',
    maxAttempts: 2,
    sleep: async () => {},
    fetch: (async (input, init) => {
      const request = new Request(input, init),
        path = new URL(request.url).pathname;
      if (request.method === 'GET') {
        const facts = new URL(request.url).searchParams.get('fieldGroup') === 'facts';
        return Response.json({ fenced: fenced && facts, securityRevision: fenced && facts ? '1' : null });
      }
      if (path === '/v1/subjects:batchWrite') {
        const body = (await request.json()) as BatchWriteRequest;
        batches.push(body);
        return Response.json({
          results: body.commands.map((c) =>
            c.op === 'create'
              ? { key: c.key, status: 201, value: { id: subject, revision: 1 } }
              : c.op === 'propose'
                ? {
                    key: c.key,
                    status: 201,
                    value: {
                      candidate: `00000000-0000-4000-8000-${String(++candidate).padStart(12, '0')}`,
                      revision: 1,
                    },
                  }
                : { key: c.key, status: 200, value: { revision: 1 } },
          ),
        } satisfies BatchWriteResult);
      }
      expect(path).toBe(`/v1/subjects/${subject}/source-statistics/vndb${request.method === 'POST' ? ':clear' : ''}`);
      const bytes = await request.text();
      writes.push({ method: request.method, bytes, key: request.headers.get('idempotency-key') });
      if (failure === 'denied') return Response.json({ code: 'forbidden' }, { status: 403 });
      if (failure === 'lost') throw new TypeError('Local committed clear response lost');
      return request.method === 'POST'
        ? new Response(null, { status: 204 })
        : Response.json({ source: 'vndb', ...JSON.parse(bytes) });
    }) as typeof fetch,
  });
  const open = () =>
    new Importer({
      path: join(directory, 'state.sqlite'),
      transport: {
        batchWrite: (body) => transport.batch(body),
        readFence: (tuple) =>
          transport.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
        writeSourceStatistic: transport.writeSourceStatistic,
        clearSourceStatistic: transport.clearSourceStatistic,
      },
    });
  let importer = open();
  return {
    writes,
    batches,
    fail(value: typeof failure) {
      failure = value;
    },
    fence() {
      fenced = true;
    },
    baseline: () => importer.session.store.source('vndb'),
    async run(row: SourceRecord) {
      return importer.runRecords(
        registration,
        (async function* () {
          yield row;
        })(),
      );
    },
    async reopen() {
      await importer.close();
      importer = open();
    },
    async close() {
      await importer.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('zero clear and unknown omission retain exact semantic candidates, unchanged reopen sends no statistic', async () => {
  const f = await fixture();
  try {
    expect((await f.run(record(2, 700))).status).toBe('committed');
    const batches = structuredClone(f.batches);
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(JSON.parse(f.writes.at(-1)!.bytes)).toEqual({ sourceRecordId: 'v123', count: 0, asOf: '2026-10-25' });
    expect(f.batches).toEqual(batches);
    await f.reopen();
    const requests = f.writes.length;
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(f.writes).toHaveLength(requests);
    expect((await f.run(record(2, 700))).status).toBe('committed');
    const positiveRequests = f.writes.length;
    expect((await f.run(record())).status).toBe('committed');
    expect((await f.run(record(2, null))).status).toBe('committed');
    expect(f.writes).toHaveLength(positiveRequests);
    expect(f.batches).toEqual(batches);
    expect((await f.run(record(0))).status).toBe('invalid-dump');
    expect((await f.run(record(0, 0))).status).toBe('committed');
    expect(f.writes.at(-1)!.method).toBe('POST');
  } finally {
    await f.close();
  }
});

test('uncertain and denied zero retain complete baseline; reopened sealed run reuses exact clear bytes/key', async () => {
  const f = await fixture();
  try {
    expect((await f.run(record(2, 700))).status).toBe('committed');
    const baseline = f.baseline();
    f.fail('lost');
    expect((await f.run(record(0, null))).status).toBe('bulk-failed');
    expect(f.baseline()).toEqual(baseline);
    const pending = f.writes.at(-1)!;
    await f.reopen();
    f.fail('denied');
    expect((await f.run(record(0, null))).status).toBe('bulk-failed');
    expect(f.baseline()).toEqual(baseline);
    expect(f.writes.at(-1)).toEqual(pending);
    f.fail(null);
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(f.writes.at(-1)).toEqual(pending);
    expect(f.batches.flatMap((b) => b.commands).filter((c) => c.op === 'retract')).toEqual([]);
  } finally {
    await f.close();
  }
});

test('facts fence suppresses positive publication but allows removal of the exact zero binding', async () => {
  const f = await fixture();
  try {
    expect((await f.run(record(2, 700))).status).toBe('committed');
    f.fence();
    const requests = f.writes.length;
    expect((await f.run(record(3, 800))).status).toBe('committed');
    expect(f.writes).toHaveLength(requests);
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(f.writes.at(-1)!.method).toBe('POST');
  } finally {
    await f.close();
  }
});
