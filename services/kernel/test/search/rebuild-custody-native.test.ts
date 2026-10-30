import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import pg, { type Pool } from 'pg';
import { newId } from '../../src/route/route.ts';
import { documentActions } from '../../src/search/document.ts';
import { RebuildError, rebuildSubjects } from '../../src/search/generations.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import {
  createOpenSearch,
  OpenSearchError,
  SearchUnavailableError,
  type OpenSearch,
} from '../../src/search/opensearch.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';
import {
  capture,
  costOf,
  growthByteViolations,
  growthViolations,
  openGrowthDatabase,
  settle,
  type GrowthSample,
} from '../support/growth.ts';

const url = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!url || !searchUrl) throw new Error('Native check database and OpenSearch are required');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const native = createOpenSearch(searchUrl);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

type Receipt = { status: number; body: unknown };
type Snapshot = { position: bigint; count: number };
type Call = { method: string; path: string; bytes: number; responseBytes: number };
const book = (partition: number): IndexedSubject => ({
  id: newId(partition * 16),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Home ${partition}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});

/** Controlled bodies, real native log/positions, checkpoints and external-version engine writes.
 * This adapter receipt test makes no Semantic publication/permission/population claim. */
async function fixture(homes = [3600, 3601], dbPool: Pool = pool, replay = false) {
  const prefix = `custody-${crypto.randomUUID().slice(0, 8)}-`;
  const consumer = subjectConsumer(prefix, 2);
  const index = subjectIndexName(prefix, 2);
  const { rows: saved } = await admin.query<{ partition_no: number; position: string }>(
    'SELECT partition_no, position::text FROM core.partition WHERE partition_no = ANY($1)',
    [homes],
  );
  const homeCounts = new Map<number, number>();
  const bodies = new (class extends Map<string, IndexedSubject> {
    override set(id: string, subject: IndexedSubject) {
      if (!this.has(id)) {
        const home = subjectPartition(id);
        homeCounts.set(home, (homeCounts.get(home) ?? 0) + 1);
      }
      return super.set(id, subject);
    }
  })();
  const calls: Call[] = [];
  const counted: number[] = [];
  const reads: { home: number; ids: string[]; position: bigint }[] = [];
  let inFlight = 0,
    peak = 0;
  const control: {
    count?: (home: number, snapshot: Snapshot) => unknown | Promise<unknown>;
    request?: (method: string, path: string, body: unknown) => Promise<Receipt | undefined>;
    receipt?: (method: string, path: string, response: Receipt) => Receipt | Promise<Receipt>;
    afterAggregation?: () => Promise<void>;
  } = {};
  const search: OpenSearch = {
    ...native,
    request: (async (method, path, body, options) => {
      const call = {
        method,
        path,
        bytes: Buffer.byteLength(JSON.stringify([method, path, body, options])),
        responseBytes: 0,
      };
      calls.push(call);
      try {
        const raw =
          (await control.request?.(method, path, body)) ?? (await native.request(method, path, body, options));
        call.responseBytes = Buffer.byteLength(JSON.stringify(raw));
        if (path === `/${index}/_search`) await control.afterAggregation?.();
        return control.receipt ? control.receipt(method, path, structuredClone(raw)) : raw;
      } catch (error) {
        if (error instanceof OpenSearchError)
          call.responseBytes = Buffer.byteLength(JSON.stringify({ status: error.status, body: error.body }));
        throw error;
      }
    }) as OpenSearch['request'],
  };
  async function position(home: number) {
    const { rows } = await dbPool.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no = $1',
      [home],
    );
    return BigInt(rows[0]!.position);
  }
  const source: SubjectSource = {
    async read(home, ids) {
      const version = await position(home);
      const subjects = ids.flatMap((id) => (bodies.has(id) ? [bodies.get(id)!] : []));
      reads.push({ home, ids: [...ids], position: version });
      return { partition: home, position: version, subjects };
    },
    async count(home) {
      counted.push(home);
      peak = Math.max(peak, ++inFlight);
      try {
        const version = await position(home);
        const snapshot = { position: version, count: homeCounts.get(home) ?? 0 };
        return (control.count ? await control.count(home, snapshot) : snapshot) as Snapshot;
      } finally {
        inFlight--;
      }
    },
  };
  await admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = ANY($1)', [homes, replay ? 0 : 1]);
  if (!replay) await checkpoint();
  await createSubjectIndex(native, prefix, 1);
  await native.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  async function checkpoint() {
    await admin.query(
      `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
       SELECT partition_no, $1, epoch, position FROM core.partition WHERE position > 0
       ON CONFLICT (partition_no, consumer) DO UPDATE SET epoch = EXCLUDED.epoch, position = EXCLUDED.position`,
      [consumer],
    );
  }
  async function append(item: IndexedSubject) {
    bodies.set(item.id, item);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ epoch: number; position: string }>(
        'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
        [subjectPartition(item.id)],
      );
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, 0, 1, $3, $4, 'com.rezics.subject.created.v1', $5, jsonb_build_object('id', $5::text))`,
        [subjectPartition(item.id), rows[0]!.position, rows[0]!.epoch, crypto.randomUUID(), item.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    prefix,
    consumer,
    index,
    bodies,
    source,
    search,
    control,
    calls,
    counted,
    reads,
    append,
    checkpoint,
    get peak() {
      return peak;
    },
    async run(extra: Partial<Parameters<typeof rebuildSubjects>[0]> = {}) {
      return rebuildSubjects({
        pool: dbPool,
        search,
        source,
        prefix,
        runner: { async refresh() {} },
        pollMs: 0,
        rounds: 1,
        timeoutMs: 1000,
        ...extra,
      });
    },
    async active() {
      return (await subjectGenerations(native, prefix)).active;
    },
    async visible(target = subjectAlias(prefix)) {
      const { body } = await native.request<{ hits: { hits: { _id: string; _version: number; _index: string }[] } }>(
        'POST',
        `/${target}/_search`,
        { size: 4096, version: true, query: { match_all: {} } },
      );
      return body.hits.hits.sort((a, b) => a._id.localeCompare(b._id));
    },
    async seed(items: IndexedSubject[]) {
      await createSubjectIndex(native, prefix, 2);
      for (let offset = 0; offset < items.length; offset += 256) {
        const actions = items
          .slice(offset, offset + 256)
          .flatMap((item) =>
            documentActions({ partition: subjectPartition(item.id), position: 1n, subjects: [item] }, [item.id]),
          );
        await writeIndexActions(native, index, actions);
      }
    },
    async close() {
      // Only fixture-owned consumers, outbox positions, heads and indices are changed.
      for (const generation of [1, 2, 3])
        await native.request('DELETE', `/${subjectIndexName(prefix, generation)}`).catch(() => undefined);
      await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1)', [
        [consumer, subjectConsumer(prefix, 1)],
      ]);
      if (replay)
        for (const row of saved)
          await admin.query('DELETE FROM core.outbox WHERE partition_no = $1 AND position > $2', [
            row.partition_no,
            row.position,
          ]);
      await admin.query(
        `UPDATE core.partition p SET position = prior.position
         FROM unnest($1::integer[], $2::bigint[]) AS prior(partition_no, position)
         WHERE p.partition_no = prior.partition_no`,
        [saved.map((row) => row.partition_no), saved.map((row) => row.position)],
      );
    },
  };
}

function activations(calls: Call[]) {
  return calls.filter((call) => call.path === '/_aliases');
}
async function unavailable(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(f.run()).rejects.toBeInstanceOf(SearchUnavailableError);
  expect(activations(f.calls)).toHaveLength(0);
  expect(await f.active()).toBe(1);
}

const invalidSnapshots: [string, (snapshot: Snapshot) => unknown][] = [
  ['missing', () => undefined],
  ['null', () => null],
  ['array', () => []],
  ['missing position', ({ count }) => ({ count })],
  ['missing count', ({ position }) => ({ position })],
  ['extra field', (snapshot) => ({ ...snapshot, partial: false })],
  ...[-1n, 9_223_372_036_854_775_808n, 1, '1', null, undefined].map(
    (position): [string, (snapshot: Snapshot) => unknown] => [
      `position ${String(position)}`,
      (snapshot) => ({ ...snapshot, position }),
    ],
  ),
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null, undefined].map(
    (count): [string, (snapshot: Snapshot) => unknown] => [
      `count ${String(count)}`,
      (snapshot) => ({ ...snapshot, count }),
    ],
  ),
];
test('every actually received malformed Source count snapshot refuses activation and recovers', async () => {
  const f = await fixture();
  try {
    for (const [name, corrupt] of invalidSnapshots) {
      f.calls.length = 0;
      f.control.count = (home, snapshot) => (home === 3600 ? corrupt(snapshot) : snapshot);
      await unavailable(f);
      expect(f.counted).toContain(3600);
      expect(f.peak, name).toBeLessThanOrEqual(8);
    }
    delete f.control.count;
    expect(await f.run()).toEqual({ generation: 2, previous: 1 });
    expect(await f.visible()).toEqual([]);
  } finally {
    await f.close();
  }
}, 60_000);

test('coincident numeric counts at stale or ahead positions stay busy, including the PostgreSQL bigint boundary', async () => {
  const f = await fixture();
  try {
    for (const position of [0n, 2n, 9_223_372_036_854_775_807n]) {
      f.control.count = (home, snapshot) => (home === 3600 ? { ...snapshot, position } : snapshot);
      f.counted.length = 0;
      await expect(f.run({ rounds: 3 })).rejects.toMatchObject({
        reason: 'busy',
        partitions: [{ partition: 3600, source: 0, indexed: 0 }],
      });
      expect(f.counted.filter((home) => home === 3600)).toHaveLength(3);
      expect(await f.active()).toBe(1);
    }
    let observations = 0;
    f.control.count = (home, snapshot) =>
      home === 3600 && ++observations < 3 ? { ...snapshot, position: 0n } : snapshot;
    expect(await f.run({ rounds: 3 })).toEqual({ generation: 2, previous: 1 });
    expect(observations).toBe(3);
  } finally {
    await f.close();
  }
}, 60_000);

test('an actual quiet PostgreSQL bigint boundary position remains a valid empty snapshot', async () => {
  const f = await fixture([3600]);
  try {
    await admin.query('UPDATE core.partition SET position = $1 WHERE partition_no = 3600', ['9223372036854775807']);
    await f.checkpoint();
    expect(await f.run()).toEqual({ generation: 2, previous: 1 });
    expect(await f.visible()).toEqual([]);
  } finally {
    await f.close();
  }
}, 60_000);

test('real empty and zero counts succeed while quiet count mismatches and unexpected indexed homes remain mismatches', async () => {
  for (const kind of ['empty', 'zero', 'source-ahead', 'index-ahead', 'unexpected'] as const) {
    const homes = kind === 'empty' ? [] : [3600];
    const f = await fixture(homes);
    try {
      const item = book(kind === 'unexpected' ? 3699 : 3600);
      if (kind === 'source-ahead') f.bodies.set(item.id, item);
      if (kind === 'index-ahead' || kind === 'unexpected') await f.seed([item]);
      if (kind === 'empty' || kind === 'zero') {
        expect(await f.run()).toEqual({ generation: 2, previous: 1 });
        expect(await f.visible()).toEqual([]);
      } else {
        await expect(f.run()).rejects.toMatchObject({
          reason: 'mismatch',
          partitions: [
            {
              partition: subjectPartition(item.id),
              source: kind === 'source-ahead' ? 1 : 0,
              indexed: kind === 'source-ahead' ? 0 : 1,
            },
          ],
        });
        expect(await f.active()).toBe(1);
        expect(activations(f.calls)).toHaveLength(0);
      }
    } finally {
      await f.close();
    }
  }
}, 60_000);

type Aggregation = {
  doc_count_error_upper_bound?: unknown;
  sum_other_doc_count?: unknown;
  buckets: Record<string, unknown>[];
};
const aggregationControls: [string, (aggregation: Aggregation, body: Record<string, unknown>) => void][] = [
  [
    'missing aggregation',
    (_, body) => {
      delete body.aggregations;
    },
  ],
  [
    'missing buckets',
    (aggregation) => {
      delete (aggregation as Partial<Aggregation>).buckets;
    },
  ],
  ...['doc_count_error_upper_bound', 'sum_other_doc_count'].flatMap(
    (field): [string, (aggregation: Aggregation) => void][] =>
      [undefined, null, -1, 1, 0.5, '0'].map((value) => [
        `${field} ${String(value)}`,
        (aggregation) => {
          (aggregation as Record<string, unknown>)[field] = value;
        },
      ]),
  ),
  [
    'duplicate',
    (aggregation) => {
      aggregation.buckets.push({ ...aggregation.buckets[0] });
    },
  ],
  ...[-1, 4096, '3600', 1.5].map((key): [string, (aggregation: Aggregation) => void] => [
    `key ${key}`,
    (aggregation) => {
      aggregation.buckets[0]!.key = key;
    },
  ]),
  ...[-1, Number.MAX_SAFE_INTEGER + 1, 1.5, '1', null].map((value): [string, (aggregation: Aggregation) => void] => [
    `bucket count ${value}`,
    (aggregation) => {
      aggregation.buckets[0]!.doc_count = value;
    },
  ]),
  [
    'bucket error',
    (aggregation) => {
      aggregation.buckets[0]!.doc_count_error_upper_bound = 1;
    },
  ],
  [
    'too many buckets',
    (aggregation) => {
      aggregation.buckets = Array.from({ length: 4097 }, () => ({ key: 1, doc_count: 0 }));
    },
  ],
  [
    'timeout',
    (_, body) => {
      body.timed_out = true;
    },
  ],
  [
    'terminated',
    (_, body) => {
      body.terminated_early = true;
    },
  ],
  [
    'shards',
    (_, body) => {
      body._shards = { total: 2, successful: 1, skipped: 0, failed: 1 };
    },
  ],
];
test('actually executed native terms aggregation must supply complete unique integral partition evidence', async () => {
  const f = await fixture([3600]);
  try {
    const item = book(3600);
    f.bodies.set(item.id, item);
    await f.seed([item]);
    let aggregations = 0;
    for (const [name, corrupt] of aggregationControls) {
      f.calls.length = 0;
      f.control.receipt = (_, path, response) => {
        if (path === `/${f.index}/_search`) {
          aggregations++;
          const body = response.body as Record<string, unknown>;
          const aggregation = (body.aggregations as { partitions: Aggregation }).partitions;
          expect(aggregation).toMatchObject({
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
            buckets: [{ key: 3600, doc_count: 1 }],
          });
          corrupt(aggregation, body);
        }
        return response;
      };
      await unavailable(f);
      expect(
        f.calls.filter((call) => call.path.endsWith('/_search')),
        name,
      ).toHaveLength(1);
    }
    expect(aggregations).toBe(aggregationControls.length);
    delete f.control.receipt;
    expect(await f.run()).toEqual({ generation: 2, previous: 1 });
    expect((await f.visible()).map((hit) => hit._id)).toEqual([item.id]);
  } finally {
    await f.close();
  }
}, 60_000);

async function checkpointAt(home: number, consumer: string) {
  await admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
     SELECT partition_no, $2, epoch, position FROM core.partition WHERE partition_no = $1
     ON CONFLICT (partition_no, consumer) DO UPDATE SET position = EXCLUDED.position`,
    [home, consumer],
  );
}

test('native before/count/after changes, removed and newly observed homes remain pending before bounded recovery', async () => {
  for (const schedule of ['during-count', 'after-count', 'removed', 'added', 'checkpoint-behind'] as const) {
    const f = await fixture([3600, 3601]);
    try {
      if (schedule === 'added') await admin.query('UPDATE core.partition SET position = 0 WHERE partition_no = 3601');
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let gate = true;
      f.control.count = async (home, snapshot) => {
        if (schedule === 'during-count' && home === 3600 && gate) {
          gate = false;
          reached.resolve();
          await release.promise;
        }
        return snapshot;
      };
      f.control.afterAggregation = async () => {
        if (schedule !== 'during-count' && gate) {
          gate = false;
          reached.resolve();
          await release.promise;
        }
      };
      const pending = f.run().catch((error: unknown) => error);
      await bounded(reached.promise);
      const home = schedule === 'added' ? 3601 : 3600;
      try {
        await admin.query('UPDATE core.partition SET position = $2 WHERE partition_no = $1', [
          home,
          schedule === 'removed' ? 0 : 2,
        ]);
        if (schedule !== 'checkpoint-behind') await checkpointAt(home, f.consumer);
      } finally {
        release.resolve();
      }
      const result = await bounded(pending);
      expect(result).toBeInstanceOf(RebuildError);
      expect(result).toMatchObject({ reason: 'busy' });
      expect(await f.active()).toBe(1);
      expect(activations(f.calls)).toHaveLength(0);
      expect(new Set(f.counted).size).toBe(f.counted.length);
      if (schedule === 'added') expect(f.counted).toContain(3601);
      await f.checkpoint();
      expect(await f.run()).toEqual({ generation: 2, previous: 1 });
    } finally {
      await f.close();
    }
  }
}, 60_000);

test('malformed count on a newly observed native home is unavailable rather than a zero diagnostic', async () => {
  const f = await fixture([3600, 3601]);
  try {
    await admin.query('UPDATE core.partition SET position = 0 WHERE partition_no = 3601');
    f.control.afterAggregation = async () => {
      await admin.query('UPDATE core.partition SET position = 1 WHERE partition_no = 3601');
      await checkpointAt(3601, f.consumer);
    };
    f.control.count = (home, snapshot) => (home === 3601 ? { count: 0 } : snapshot);
    await unavailable(f);
    expect(f.counted.filter((home) => home === 3601)).toHaveLength(1);
    delete f.control.afterAggregation;
    delete f.control.count;
    expect(await f.run()).toEqual({ generation: 2, previous: 1 });
  } finally {
    await f.close();
  }
}, 60_000);

async function bounded<T>(promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('native fixture operation did not finish')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('actual multi-partition runner replay uses external versions and exposes only the atomic native alias effect', async () => {
  const f = await fixture([3600, 3601, 3602], pool, true);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let runner: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  let rebuilding: Promise<unknown> | undefined;
  try {
    const items = [book(3600), book(3600), book(3601), book(3602)];
    for (const item of items) await f.append(item);
    runner = await startSearchIndexing({
      pool,
      search: native,
      source: f.source,
      prefix: f.prefix,
      listing: {
        async read() {
          return new Map<string, number>();
        },
      },
      intervalMs: 5,
      discoverMs: 100_000,
    });
    let gated = false;
    f.control.count = async (_, snapshot) => {
      if (!gated) {
        gated = true;
        reached.resolve();
        await release.promise;
      }
      return snapshot;
    };
    let switched = 0;
    f.control.receipt = async (method, path, response) => {
      if (method === 'POST' && path === '/_aliases') {
        switched++;
        expect(await f.active()).toBe(2);
        expect((await f.visible()).every((hit) => hit._index === f.index)).toBe(true);
      }
      return response;
    };
    rebuilding = f.run({ runner, pollMs: 5, timeoutMs: 10_000 });
    await bounded(reached.promise);
    expect(await f.active()).toBe(1);
    const expected = items.map((item) => item.id).sort();
    expect((await f.visible()).map((hit) => hit._id).sort()).toEqual(expected);
    expect((await f.visible(f.index)).map((hit) => hit._id).sort()).toEqual(expected);
    release.resolve();
    expect(await bounded(rebuilding)).toEqual({ generation: 2, previous: 1 });
    expect(switched).toBe(1);
    const visible = await f.visible();
    for (const item of items) {
      const home = subjectPartition(item.id);
      expect(visible.find((hit) => hit._id === item.id)).toMatchObject({
        _index: f.index,
        _version: home === 3600 ? 2 : 1,
      });
    }
    expect(new Set(f.reads.map((read) => read.home))).toEqual(new Set([3600, 3601, 3602]));
    expect(f.reads.every((read) => read.ids.length <= 256 && read.position >= 1n)).toBe(true);
    const { rows } = await admin.query<{ partition_no: number; position: string }>(
      'SELECT partition_no, position::text FROM core.consumer_checkpoint WHERE consumer = $1 ORDER BY partition_no',
      [f.consumer],
    );
    expect(rows).toEqual([
      { partition_no: 3600, position: '2' },
      { partition_no: 3601, position: '1' },
      { partition_no: 3602, position: '1' },
    ]);
    expect(f.counted.sort((a, b) => a - b)).toEqual([3600, 3601, 3602]);
    expect(f.calls.filter((call) => call.path === `/${f.index}/_search`)).toHaveLength(1);
  } finally {
    release.resolve();
    await rebuilding?.catch(() => undefined);
    await runner?.stop();
    await f.close();
  }
}, 60_000);

for (const stage of ['mapping', 'alias'] as const) {
  test(`failed native ${stage} effect stays unavailable and a later rebuild recovers the actual generation`, async () => {
    const f = await fixture([3600]);
    let dispatched = 0;
    try {
      f.control.request = async (method, path) => {
        if (stage === 'mapping' && method === 'PUT' && path === `/${f.index}/_mapping`) {
          dispatched++;
          // Really execute a rejected native mapping; never manufacture a successful ACK.
          return native.request(method, path, { properties: { partition: { type: 'text' } } });
        }
        if (stage === 'alias' && method === 'POST' && path === '/_aliases') {
          dispatched++;
          return native.request(method, path, {
            actions: [{ add: { index: `${f.prefix}missing`, alias: subjectAlias(f.prefix) } }],
          });
        }
      };
      await expect(f.run()).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(dispatched).toBe(1);
      expect(await f.active()).toBe(1);
      expect(activations(f.calls)).toHaveLength(stage === 'mapping' ? 0 : 1);
      delete f.control.request;
      expect(await f.run()).toEqual({ generation: 2, previous: 1 });
      expect(await f.active()).toBe(2);
    } finally {
      await f.close();
    }
  }, 60_000);

  test(`applied native ${stage} effects with negative malformed or lost replies require fresh definitive observations`, async () => {
    for (const mode of ['negative', 'malformed', 'lost', 'unobserved', 'wrong-target'] as const) {
      const f = await fixture([3600]);
      let writes = 0,
        observations = 0;
      try {
        const item = book(3600);
        f.bodies.set(item.id, item);
        await f.seed([item]);
        f.control.receipt = (method, path, response) => {
          const write =
            stage === 'mapping'
              ? method === 'PUT' && path === `/${f.index}/_mapping`
              : method === 'POST' && path === '/_aliases';
          if (write) {
            writes++;
            expect(response).toMatchObject({ status: 200, body: { acknowledged: true } });
            if (mode === 'lost') throw new SearchUnavailableError('controlled lost native write reply');
            return { status: 200, body: mode === 'negative' ? { acknowledged: false } : {} };
          }
          const observe =
            writes > 0 &&
            (stage === 'mapping'
              ? method === 'GET' && path === `/${f.index}/_mapping`
              : path.startsWith('/_resolve/index/'));
          if (observe) {
            observations++;
            if (mode === 'unobserved') throw new SearchUnavailableError('controlled lost native observation');
            if (mode === 'wrong-target') {
              if (stage === 'mapping')
                response.body = { foreign: Object.values(response.body as Record<string, unknown>)[0] };
              else {
                const body = response.body as { aliases: { indices: string[] }[] };
                body.aliases[0]!.indices = [subjectIndexName(f.prefix, 1)];
              }
            }
          }
          return response;
        };
        if (mode === 'unobserved' || mode === 'wrong-target') {
          await expect(f.run()).rejects.toBeInstanceOf(SearchUnavailableError);
          // Lost observations never imply that the old alias survived an applied switch.
          expect(await f.active()).toBe(stage === 'alias' ? 2 : 1);
        } else {
          expect(await f.run()).toEqual({ generation: 2, previous: 1 });
          expect(await f.active()).toBe(2);
        }
        expect(writes).toBe(1);
        expect(observations).toBe(1);
        expect(
          (
            await f.visible(
              stage === 'alias' || !['unobserved', 'wrong-target'].includes(mode) ? subjectAlias(f.prefix) : f.index,
            )
          ).map((hit) => hit._id),
        ).toEqual([item.id]);
        if ((mode === 'unobserved' || mode === 'wrong-target') && stage === 'mapping') {
          delete f.control.receipt;
          expect(await f.run()).toEqual({ generation: 2, previous: 1 });
        }
      } finally {
        await f.close();
      }
    }
  }, 60_000);
}

test('a concurrent native alias change after our applied write is reported without retry or rollback', async () => {
  const f = await fixture([3600]);
  try {
    f.control.receipt = async (method, path, response) => {
      if (method === 'POST' && path === '/_aliases') {
        await createSubjectIndex(native, f.prefix, 3);
        await native.request('POST', '/_aliases', {
          actions: [
            { remove: { index: f.index, alias: subjectAlias(f.prefix) } },
            { add: { index: subjectIndexName(f.prefix, 3), alias: subjectAlias(f.prefix) } },
          ],
        });
      }
      return response;
    };
    await expect(f.run()).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(await f.active()).toBe(3);
    expect(activations(f.calls)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

// These measurements include rebuild SQL, native position reads by the controlled
// count adapter, all reconciliation engine requests and serialized native bytes.
// They exclude replay (proved above), engine internal aggregation work, Semantic
// indexed count maintenance and body lookup; the owner's native count cost is additional.
test('one fixed native rebuild retains its work across 64/512/4096 unrelated histories', async () => {
  const db = await openGrowthDatabase(url);
  const f = await fixture([3600], db.pool);
  const samples: GrowthSample[] = [];
  const measuredCalls: { requests: number; requestBytes: number; responseBytes: number }[] = [];
  const historyType = `custody-history-${crypto.randomUUID()}`;
  try {
    // All historical rows are behind an already-consumed native head. No replay
    // or planner forcing is hidden in the measured reconciliation operation.
    await admin.query('UPDATE core.partition SET position = 4096 WHERE partition_no = 3600');
    await f.checkpoint();
    // Warm the exact resumed-generation metadata shape before measuring bytes.
    await f.run();
    let previous = 0;
    for (const scale of [64, 512, 4096]) {
      await admin.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         SELECT 3600, n, 0, 1, 1, gen_random_uuid(), $1, NULL, '{}'::jsonb
         FROM generate_series($2::int, $3::int) n`,
        [historyType, previous + 1, scale],
      );
      await admin.query(
        `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
         SELECT 3600, $1 || n::text, 1, 1 FROM generate_series($2::int, $3::int) n`,
        [`custody_unrelated_${f.prefix.replaceAll('-', '_')}_`, previous + 1, scale],
      );
      previous = scale;
      await createSubjectIndex(native, f.prefix, 2);
      await native.request('POST', '/_aliases', {
        actions: [
          { remove: { index: f.index, alias: subjectAlias(f.prefix), must_exist: false } },
          { add: { index: subjectIndexName(f.prefix, 1), alias: subjectAlias(f.prefix) } },
        ],
      });
      await settle(db);
      f.calls.length = 0;
      f.counted.length = 0;
      const measured = await capture(db, () => f.run());
      expect(measured.value).toEqual({ generation: 2, previous: 1 });
      const cost = costOf(measured.capture);
      samples.push({ scale, cost });
      expect(f.counted).toEqual([3600]);
      expect(f.peak).toBeLessThanOrEqual(8);
      expect(f.calls.filter((call) => call.path.endsWith('/_search'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.method === 'PUT' && call.path.endsWith('/_mapping'))).toHaveLength(1);
      expect(activations(f.calls)).toHaveLength(1);
      expect(measured.capture.statements.some((sql) => /FROM core\.outbox/i.test(sql) && !sql.includes('oldest'))).toBe(
        false,
      );
      measuredCalls.push({
        requests: f.calls.length,
        requestBytes: f.calls.reduce((sum, call) => sum + call.bytes, 0),
        responseBytes: f.calls.reduce((sum, call) => sum + call.responseBytes, 0),
      });
      console.info(
        'native fixed rebuild custody',
        JSON.stringify({ scale, cost, engine: measuredCalls.at(-1), counted: f.counted }),
      );
    }
    expect(growthViolations(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' })).toEqual([]);
    expect(new Set(measuredCalls.map((calls) => calls.requests)).size).toBe(1);
    expect(new Set(measuredCalls.map((calls) => calls.requestBytes)).size).toBe(1);
    expect(
      growthByteViolations(
        samples.map((sample, n) => ({
          ...sample,
          cost: {
            ...sample.cost,
            requestBytes: measuredCalls[n]!.requestBytes,
            responseBytes: measuredCalls[n]!.responseBytes,
          },
        })),
        { requestBytes: 'constant', responseBytes: 'constant' },
      ),
    ).toEqual([]);
  } finally {
    await admin.query('DELETE FROM core.outbox WHERE type = $1', [historyType]);
    await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer LIKE $1', [
      `custody_unrelated_${f.prefix.replaceAll('-', '_')}_%`,
    ]);
    await f.close();
    await db.close();
  }
}, 120_000);

test('actual nonempty partition work grows linearly to 4096 with exact keys and bounded eight-count concurrency', async () => {
  const db = await openGrowthDatabase(url);
  const samples: GrowthSample[] = [];
  const engineSamples: GrowthSample[] = [];
  try {
    for (const scale of [64, 512, 4096]) {
      const homes = Array.from({ length: scale }, (_, n) => n);
      const f = await fixture(homes, db.pool);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let rebuilding: ReturnType<typeof capture<Awaited<ReturnType<typeof f.run>>>> | undefined;
      try {
        const items = homes.map(book);
        for (const item of items) f.bodies.set(item.id, item);
        await f.seed(items);
        await settle(db);
        let entered = 0;
        f.control.count = async (_, snapshot) => {
          if (++entered <= 8) {
            if (entered === 8) reached.resolve();
            await release.promise;
          }
          return snapshot;
        };
        f.calls.length = 0;
        f.counted.length = 0;
        rebuilding = capture(db, () => f.run());
        await bounded(reached.promise);
        expect(f.counted).toHaveLength(8);
        expect(f.peak).toBe(8);
        release.resolve();
        const measured = await bounded(rebuilding, 120_000);
        expect(measured.value).toEqual({ generation: 2, previous: 1 });
        const cost = costOf(measured.capture);
        samples.push({ scale, cost });
        engineSamples.push({
          scale,
          cost: {
            rows: 0,
            blocks: 0,
            statements: f.calls.length,
            requestBytes: f.calls.reduce((sum, call) => sum + call.bytes, 0),
            responseBytes: f.calls.reduce((sum, call) => sum + call.responseBytes, 0),
          },
        });
        expect(f.counted.sort((a, b) => a - b)).toEqual(homes);
        expect(f.peak).toBe(8);
        expect(f.calls.filter((call) => call.path.endsWith('/_search'))).toHaveLength(1);
        expect(activations(f.calls)).toHaveLength(1);
        expect(f.calls.filter((call) => call.method === 'GET')).toHaveLength(5);
        expect((await f.visible()).map((hit) => hit._id).sort()).toEqual(items.map((item) => item.id).sort());
        console.info(
          'native partition rebuild custody',
          JSON.stringify({
            scale,
            cost,
            engineRequests: f.calls.length,
            engineRequestBytes: f.calls.reduce((sum, call) => sum + call.bytes, 0),
            engineResponseBytes: f.calls.reduce((sum, call) => sum + call.responseBytes, 0),
            counted: f.counted.length,
            uniqueKeys: new Set(f.counted).size,
            peak: f.peak,
          }),
        );
      } finally {
        release.resolve();
        await rebuilding?.catch(() => undefined);
        await f.close();
      }
    }
    expect(growthViolations(samples, { rows: 'linear', blocks: 'linear', statements: 'linear' })).toEqual([]);
    expect(growthViolations(engineSamples, { rows: 'constant', blocks: 'constant', statements: 'constant' })).toEqual(
      [],
    );
    expect(growthByteViolations(engineSamples, { requestBytes: 'constant', responseBytes: 'linear' })).toEqual([]);
  } finally {
    await db.close();
  }
}, 180_000);
