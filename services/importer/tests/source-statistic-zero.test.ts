import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const directory = await mkdtemp(join(tmpdir(), 'source-zero-'));
  let failure: 'lost' | 'denied' | null = null;
  let fenced = false;
  const writes: { method: string; bytes: string; key: string | null }[] = [];
  const batches: BatchWriteRequest[] = [];
  let candidate = 0;
  const metadata = sourceRecordMetadataFixture();
  const transport = createImportTransport({
    origin: 'https://zero.import.test',
    tokenProvider: async () => 'local-protocol-token',
    maxAttempts: 2,
    sleep: async () => {},
    fetch: (async (input, init) => {
      const request = new Request(input, init),
        path = new URL(request.url).pathname;
      if (path === '/v1/source-records:setMetadata') return metadata.fetch(request);
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
        setSourceRecordMetadata: transport.setSourceRecordMetadata,
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
    get importer() {
      return importer;
    },
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
    async resume() {
      let consumed = false;
      const result = await importer.runRecords(
        registration,
        (async function* () {
          consumed = true;
          yield record(9, 900);
        })(),
      );
      expect(consumed).toBe(false);
      return result;
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

async function resolveOpen(f: Awaited<ReturnType<typeof fixture>>) {
  const pending = await f.importer.pageObservationConflicts('vndb');
  expect(pending.operations.length).toBeGreaterThan(0);
  const resolved = await f.importer.resolveObservation(
    'vndb',
    pending.operations[0]!.operationId,
    pending.operations[0]!.reviewedHead!.digest,
  );
  expect(resolved.status).toBe('delivered');
}

test('zero clear and unknown omission retain exact semantic candidates, unchanged reopen sends no statistic', async () => {
  const f = await fixture();
  try {
    expect((await f.run(record(2, 700))).status).toBe('committed');
    const batches = structuredClone(f.batches);
    expect((await f.run(record(0, null))).status).toBe('observation-conflict');
    await resolveOpen(f);
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(JSON.parse(f.writes.at(-1)!.bytes)).toMatchObject({ sourceRecordId: 'v123', count: 0, asOf: '2026-10-25' });
    expect(f.batches).toEqual(batches);
    await f.reopen();
    const requests = f.writes.length;
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(f.writes).toHaveLength(requests);
    expect((await f.run(record(2, 700))).status).toBe('observation-conflict');
    await resolveOpen(f);
    expect((await f.run(record(2, 700))).status).toBe('committed');
    const positiveRequests = f.writes.length;
    expect((await f.run(record())).status).toBe('committed');
    expect((await f.run(record(2, null))).status).toBe('committed');
    expect(f.writes).toHaveLength(positiveRequests);
    expect(f.batches).toEqual(batches);
    expect((await f.run(record(0))).status).toBe('invalid-dump');
    expect((await f.run(record(0, 0))).status).toBe('observation-conflict');
    await resolveOpen(f);
    expect((await f.run(record(0, 0))).status).toBe('committed');
    expect(f.writes.at(-1)!.method).toBe('POST');
  } finally {
    await f.close();
  }
});

test('uncertain and denied first write retain complete absence; reopened sealed run reuses exact bytes/key', async () => {
  const f = await fixture();
  try {
    const baseline = f.baseline();
    f.fail('lost');
    expect((await f.run(record(2, 700))).status).toBe('bulk-failed');
    expect(f.baseline()).toEqual(baseline);
    const pending = f.writes.at(-1)!;
    await f.reopen();
    f.fail('denied');
    expect((await f.resume()).status).toBe('bulk-failed');
    expect(f.baseline()).toEqual(baseline);
    expect(f.writes.at(-1)).toEqual(pending);
    f.fail(null);
    expect((await f.resume()).status).toBe('committed');
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
    expect((await f.run(record(0, null))).status).toBe('observation-conflict');
    await resolveOpen(f);
    expect((await f.run(record(0, null))).status).toBe('committed');
    expect(f.writes.at(-1)!.method).toBe('POST');
  } finally {
    await f.close();
  }
});

test('other registered sources never derive a clear from source rating fields', async () => {
  for (const [sourceKind, path, id] of [
    ['bangumi', 'bangumi/subject.json', '424242'],
    ['wikidata', 'wikidata/entity.json', 'Q571'],
    ['openlibrary', 'open-library/work.json', '/works/OL900000001W'],
  ] as const) {
    const source = createSourceRegistration(sourceKind);
    const payload = await Bun.file(new URL(`../../../specs/fixtures/imports/${path}`, import.meta.url)).json();
    const result = source.convert(
      {
        external_id: id,
        record_revision: String(payload.lastrevid ?? payload.revision ?? 7),
        record: {
          ...payload,
          c_votecount: 0,
          c_average: null,
        },
      },
      { source: source.source },
    );
    expect(result.sourceStatisticClear).toBeUndefined();
    expect(result.sourceStatistic).toBeUndefined();
  }
});

test('registered VNDB aliases use the generated positive and clear client bodies without changing native identity', async () => {
  const alias = createSourceRegistration('vndb', { source: 'feed-two' });
  const converted = (row: SourceRecord) =>
    alias.convert(
      { external_id: row.key, record_revision: row.revision!, record: row.payload },
      { source: 'feed-two' },
    );
  const positive = converted(record(2, 700));
  const zero = converted(record(0, null));
  expect(positive.sourceStatistic?.sourceAlias).toBe('feed-two');
  expect(zero.sourceStatisticClear).toEqual({
    source: 'vndb',
    sourceAlias: 'feed-two',
    sourceRecordId: 'v123',
    count: 0,
    asOf: '2026-10-25',
  });
  expect(converted(record()).sourceStatistic).toBeUndefined();
  expect(converted(record()).sourceStatisticClear).toBeUndefined();
  const native = convertVndb(
    { external_id: 'v123', record_revision: '7', record: record(0, null).payload },
    { source: 'feed-two' },
  );
  expect(zero.digest).toBe(native.digest);
  expect(zero.proposals).toEqual(native.proposals);
  const requests: { method: string; path: string; body: unknown }[] = [];
  const client = createImportTransport({
    origin: 'https://zero.import.test',
    tokenProvider: async () => 'local-protocol-token',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.json();
      requests.push({ method: request.method, path: new URL(request.url).pathname, body });
      return request.method === 'PUT'
        ? Response.json({ source: 'vndb', ...body })
        : new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const { source: provider, ...positiveValue } = positive.sourceStatistic!;
  await client.writeSourceStatistic({
    subjectId: subject,
    source: provider,
    value: positiveValue,
    idempotencyKey: 'positive-alias',
  });
  const { source, ...clearValue } = zero.sourceStatisticClear!;
  await client.clearSourceStatistic({ subjectId: subject, source, value: clearValue, idempotencyKey: 'zero-alias' });
  expect(requests).toEqual([
    { method: 'PUT', path: `/v1/subjects/${subject}/source-statistics/vndb`, body: positiveValue },
    { method: 'POST', path: `/v1/subjects/${subject}/source-statistics/vndb:clear`, body: clearValue },
  ]);
});
