import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import type { ImportTransport } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createImportTransport } from './transport-driver.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';

function vnRecord(average: number, votes: number, revision: number): SourceRecord {
  return {
    source: 'vndb',
    key: 'v123',
    revision: String(revision),
    payload: {
      vn: { id: 'v123', olang: 'en', c_average: average, c_votecount: votes, c_rating: 900 },
      entry_meta: { id: 'v123', revision },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Test visual novel', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

function resultFor(request: BatchWriteRequest, sequence: { value: number }): BatchWriteResult {
  return {
    results: request.commands.map((command) => {
      sequence.value++;
      if (command.op === 'create') return { key: command.key, status: 201, value: { id: subjectId, revision: 1 } };
      if (command.op === 'propose')
        return {
          key: command.key,
          status: 201,
          value: {
            candidate: `00000000-0000-4000-8000-${sequence.value.toString().padStart(12, '0')}`,
            revision: 1,
          },
        };
      return { key: command.key, status: 200, value: { revision: 1 } };
    }),
  };
}

test('VNDB imports and refreshes its licensed source statistic through the API without writing votes', async () => {
  const requests: { method: string; path: string; body?: unknown; key?: string }[] = [];
  const stored = new Map<string, unknown>();
  const sequence = { value: 0 };
  const transport = {
    async batchWrite(request: BatchWriteRequest) {
      requests.push({ method: 'POST', path: '/v1/subjects:batchWrite', body: request });
      return resultFor(request, sequence);
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic(input: { subjectId: string; value: Record<string, unknown>; idempotencyKey: string }) {
      requests.push({
        method: 'PUT',
        path: `/v1/subjects/${input.subjectId}/source-statistics/vndb`,
        body: input.value,
        key: input.idempotencyKey,
      });
      stored.set(input.subjectId, input.value);
    },
  } as unknown as ImportTransport;
  const importer = new Importer({ path: ':memory:', transport });
  const registration = createSourceRegistration('vndb');

  try {
    const first = await importer.runRecords(
      registration,
      (async function* () {
        yield vnRecord(735, 20, 7);
      })(),
    );
    expect(first.status).toBe('committed');
    expect(stored.get(subjectId)).toEqual({
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 7.35,
      count: 20,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });

    const second = await importer.runRecords(
      registration,
      (async function* () {
        yield vnRecord(812, 25, 8);
      })(),
    );
    expect(second.status).toBe('committed');
    expect(stored.size).toBe(1);
    expect(stored.get(subjectId)).toEqual({
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 8.12,
      count: 25,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });
    const statisticRequests = requests.filter((request) => request.path.endsWith('/source-statistics/vndb'));
    expect(statisticRequests).toHaveLength(2);
    expect(new Set(statisticRequests.map((request) => request.key)).size).toBe(2);
    expect(requests.some((request) => request.path.includes('/ratings/'))).toBe(false);
    for (const request of requests.filter((item) => item.path === '/v1/subjects:batchWrite')) {
      expect(JSON.stringify(request.body)).not.toContain('c_rating');
      expect(JSON.stringify(request.body)).not.toContain('ratings/vote');
    }
  } finally {
    await importer.close();
  }
});

test('the production import transport PUTs the VNDB statistic route with its idempotency key', async () => {
  const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const value = {
    sourceRecordId: 'v123',
    scale: { min: 1, max: 10 },
    mean: 7.35,
    count: 20,
    asOf: '2026-10-25',
    licence: 'ODbL-1.0',
    attribution: 'VNDB',
  };
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body: JSON.parse(await request.text()),
      });
      return Response.json({ source: 'vndb', ...value });
    }) as typeof fetch,
    maxAttempts: 1,
  });

  await transport.writeSourceStatistic({
    subjectId,
    source: 'vndb',
    value,
    idempotencyKey: 'source-statistic:refresh-1',
  });

  expect(requests).toEqual([
    {
      method: 'PUT',
      path: `/v1/subjects/${subjectId}/source-statistics/vndb`,
      key: '"source-statistic:refresh-1"',
      body: value,
    },
  ]);
});

test('Bangumi score fields remain omitted because its licence does not cover ratings', async () => {
  const source = Bun.YAML.parse(
    await Bun.file(new URL('../../../packages/definitions/sources/bangumi.yaml', import.meta.url)).text(),
  ) as {
    files: { id: string; fields: { id: string; mapping: { status: string; reason?: string } }[] }[];
  };
  const subject = source.files.find((file) => file.id === 'subject');
  expect(subject).toBeDefined();
  for (const fieldName of [
    'rank',
    'score',
    'score_details',
    ...Array.from({ length: 10 }, (_, index) => `score_details.${index + 1}`),
  ]) {
    expect(subject!.fields.find((field) => field.id === fieldName)?.mapping).toEqual({
      status: 'omitted',
      reason: "Bangumi's licence covers entry information and not ratings.",
    });
  }
});

// Local HTTP protocol doubles exercise the real transport, coordinator and durable
// stores. Native Auth, receipts and events are proved by the separate frozen suite.
async function statisticRefreshFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'statistic-refresh-'));
  const path = join(directory, 'journal.sqlite');
  const sequence = { value: 0 };
  const batches: BatchWriteRequest[] = [];
  const writes: { body: string; key: string | null }[] = [];
  let failure: 'denied' | 'lost' | null = null;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'local-protocol-token',
    sleep: async () => {},
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/sourceFences:check')
        return Response.json({ fenced: false, securityRevision: null });
      if (request.method === 'POST' && url.pathname === '/v1/subjects:batchWrite') {
        const body = (await request.json()) as BatchWriteRequest;
        batches.push(body);
        return Response.json(resultFor(body, sequence));
      }
      if (request.method !== 'PUT' || url.pathname !== `/v1/subjects/${subjectId}/source-statistics/vndb`)
        throw new Error('Unexpected local protocol request');
      const body = await request.text();
      writes.push({ body, key: request.headers.get('idempotency-key') });
      if (failure === 'denied') return Response.json({ code: 'forbidden' }, { status: 403 });
      if (failure === 'lost') throw new TypeError('Local statistic acknowledgement unavailable');
      return Response.json({ source: 'vndb', ...JSON.parse(body) });
    }) as typeof fetch,
  });
  const open = () =>
    new Importer({
      path,
      transport: {
        batchWrite: (request, signal) => transport.batch(request, signal),
        readFence: (tuple, signal) =>
          transport.fence(
            { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
            signal,
          ),
        writeSourceStatistic: (input, signal) => transport.writeSourceStatistic(input, signal),
      },
    });
  let importer = open();
  const owner = { source: 'vndb', external_id: 'v123' };
  return {
    batches,
    writes,
    get importer() {
      return importer;
    },
    fail(value: typeof failure) {
      failure = value;
    },
    run(average: number) {
      return importer.runRecords(
        createSourceRegistration('vndb'),
        (async function* () {
          yield vnRecord(average, 20, 7);
        })(),
      );
    },
    semanticState() {
      return {
        claim: importer.session.bindings.claim(owner),
        candidates: importer.session.bindings.candidates(owner, 'facts', { limit: 100 }),
        journals: batches.flatMap((batch) =>
          batch.commands.map((command) => importer.session.bindings.journal(owner, command.key)),
        ),
      };
    },
    async reopen() {
      await importer.close();
      importer = open();
    },
    async close() {
      try {
        await importer.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

test('same-revision statistic refresh commits its projection, retains semantic journals and becomes a reopened no-op', async () => {
  const f = await statisticRefreshFixture();
  try {
    expect((await f.run(735)).status).toBe('committed');
    const semantic = f.semanticState();
    expect(semantic.candidates.length).toBeGreaterThan(0);
    const baseline = f.importer.session.store.source('vndb');
    const originalRow = f.importer.session.store.key('vndb', 'v123').baseline;
    const batchCount = f.batches.length;
    await f.reopen();
    const changed = await f.run(810);
    expect(changed.status).toBe('committed');
    expect(changed.counts.changed).toBe(1);
    expect(f.semanticState()).toEqual(semantic);
    expect(f.batches).toHaveLength(batchCount);
    expect(f.writes).toHaveLength(2);
    expect(JSON.parse(f.writes[1]!.body).mean).toBe(8.1);
    expect(f.writes[1]!.key).not.toBe(f.writes[0]!.key);
    const refreshed = f.importer.session.store.source('vndb');
    expect(refreshed.count).toBe(1);
    expect(refreshed.generation).not.toBe(baseline.generation);
    expect(f.importer.session.store.key('vndb', 'v123').baseline?.recordRevision).toBe(originalRow?.recordRevision);
    const complete = f.importer.session.store.key('vndb', 'v123', {
      source: 'vndb',
      id: refreshed.generation!,
      lease: '',
    });
    expect(complete.staged?.projection.normalizedRecord).toMatchObject({ vn: { c_average: 810 } });
    await f.reopen();
    expect((await f.run(810)).status).toBe('committed');
    expect(f.importer.session.store.source('vndb')).toEqual(refreshed);
    expect(f.semanticState()).toEqual(semantic);
    expect(f.batches).toHaveLength(batchCount);
    expect(f.writes).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const failure of ['denied', 'lost'] as const) {
  test(`unacknowledged statistic refresh (${failure}) preserves the completed baseline and resumes under its original key`, async () => {
    const f = await statisticRefreshFixture();
    try {
      expect((await f.run(735)).status).toBe('committed');
      const baseline = f.importer.session.store.source('vndb');
      const row = f.importer.session.store.key('vndb', 'v123').acknowledged;
      const semantic = f.semanticState();
      f.fail(failure);
      expect((await f.run(810)).status).toBe('bulk-failed');
      expect(f.importer.session.store.source('vndb')).toEqual(baseline);
      expect(f.importer.session.store.key('vndb', 'v123').acknowledged).toEqual(row);
      expect(f.importer.session.store.activeRun('vndb')).not.toBeNull();
      expect(f.semanticState()).toEqual(semantic);
      const uncertain = f.writes.slice(1);
      expect(uncertain).toHaveLength(failure === 'denied' ? 1 : 5);
      for (const write of uncertain) expect(write).toEqual(uncertain[0]!);
      await f.reopen();
      expect(f.importer.session.store.source('vndb')).toEqual(baseline);
      f.fail(null);
      expect((await f.run(810)).status).toBe('committed');
      expect(f.writes.at(-1)).toEqual(uncertain[0]!);
      expect(f.semanticState()).toEqual(semantic);
      const refreshed = f.importer.session.store.source('vndb');
      expect(refreshed.generation).not.toBe(baseline.generation);
      const count = f.writes.length;
      expect((await f.run(810)).status).toBe('committed');
      expect(f.writes).toHaveLength(count);
      expect(f.importer.session.store.source('vndb')).toEqual(refreshed);
    } finally {
      await f.close();
    }
  });
}
