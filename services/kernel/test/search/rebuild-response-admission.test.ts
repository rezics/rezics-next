import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { RebuildError, rebuildSubjects } from '../../src/search/generations.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import type { SubjectSource } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { identityFixture } from '../semantic/identity-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const native = createOpenSearch(searchUrl);
const source = subjectSource(pool, new Uint8Array(32).fill(83));
const listing = subjectListingSource(pool);
const hidden = 'private-reconciliation-payload-do-not-disclose';

afterAll(async () => {
  try {
    await pool.end();
  } finally {
    await admin.end();
  }
});

type Reply = {
  timed_out: unknown;
  _shards: Record<string, unknown>;
  terminated_early?: unknown;
  aggregations?: any;
  hits: { total: { value: number }; hits: unknown[] };
};
type Fault = { name: string; change(body: Reply): void };
const faults: Fault[] = [
  {
    name: 'timed_out',
    change: (body) => {
      body.timed_out = true;
    },
  },
  {
    name: 'incomplete shards',
    change: (body) => {
      body._shards.successful = 0;
    },
  },
  {
    name: 'failed shards',
    change: (body) => {
      body._shards.successful = 0;
      body._shards.failed = 1;
      body._shards.failures = [{ reason: { reason: hidden } }];
    },
  },
  {
    name: 'terminated_early',
    change: (body) => {
      body.terminated_early = true;
    },
  },
  {
    name: 'missing aggregations',
    change: (body) => {
      delete body.aggregations;
    },
  },
  {
    name: 'null aggregations',
    change: (body) => {
      body.aggregations = null;
    },
  },
  {
    name: 'malformed aggregations',
    change: (body) => {
      body.aggregations = hidden;
    },
  },
  {
    name: 'missing partitions',
    change: (body) => {
      delete body.aggregations.partitions;
    },
  },
  {
    name: 'null partitions',
    change: (body) => {
      body.aggregations.partitions = null;
    },
  },
  {
    name: 'malformed partitions',
    change: (body) => {
      body.aggregations.partitions = hidden;
    },
  },
  {
    name: 'missing buckets',
    change: (body) => {
      delete body.aggregations.partitions.buckets;
    },
  },
  {
    name: 'null buckets',
    change: (body) => {
      body.aggregations.partitions.buckets = null;
    },
  },
  {
    name: 'object buckets',
    change: (body) => {
      body.aggregations.partitions.buckets = { payload: hidden };
    },
  },
  {
    name: 'string buckets',
    change: (body) => {
      body.aggregations.partitions.buckets = hidden;
    },
  },
  {
    name: 'null bucket',
    change: (body) => {
      body.aggregations.partitions.buckets = [null];
    },
  },
  {
    name: 'string bucket',
    change: (body) => {
      body.aggregations.partitions.buckets = [hidden];
    },
  },
  {
    name: 'missing partition',
    change: (body) => {
      body.aggregations.partitions.buckets = [{ doc_count: 0 }];
    },
  },
  {
    name: 'missing count',
    change: (body) => {
      body.aggregations.partitions.buckets = [{ key: 0 }];
    },
  },
  ...[
    ['negative', -1],
    ['out of range', 4096],
    ['fractional', 0.5],
    ['string', hidden],
    ['null', null],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ].map(([name, key]): Fault => ({
    name: `${name} partition`,
    change: (body) => {
      body.aggregations.partitions.buckets = [{ key, doc_count: 0 }];
    },
  })),
  ...[
    ['negative', -1],
    ['fractional', 0.5],
    ['string', hidden],
    ['null', null],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ].map(([name, doc_count]): Fault => ({
    name: `${name} count`,
    change: (body) => {
      body.aggregations.partitions.buckets = [{ key: 0, doc_count }];
    },
  })),
];

// This is a protocol slice of the existing operator rebuild job. Equal counts do not prove complete keys,
// source-version provenance or physical-generation lineage; those separate obligations remain open.
async function deployment(
  run: (prefix: string, runner: Awaited<ReturnType<typeof startSearchIndexing>>) => Promise<void>,
) {
  const prefix = `admit-${crypto.randomUUID().slice(0, 8)}-`;
  let runner: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  try {
    runner = await startSearchIndexing({
      pool,
      search: native,
      source,
      listing,
      prefix,
      intervalMs: 20,
      discoverMs: 50,
    });
    expect(await subjectGenerations(native, prefix)).toEqual({ generations: [1], active: 1 });
    await run(prefix, runner);
  } finally {
    try {
      await runner?.stop();
    } finally {
      try {
        for (const generation of (await subjectGenerations(native, prefix)).generations)
          await native.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
      } finally {
        // Only this deployment's consumers are owned here; the check driver owns its migrated database.
        await admin.query('DELETE FROM core.consumer_checkpoint WHERE consumer = ANY($1::text[])', [
          [subjectConsumer(prefix, 1), subjectConsumer(prefix, 2)],
        ]);
      }
    }
  }
}

function intercept(prefix: string, fault?: Fault) {
  const replies: Reply[] = [];
  const publications: string[] = [];
  const index = subjectIndexName(prefix, 2);
  const client: OpenSearch = {
    bulk: native.bulk,
    async request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      if (method === 'POST' && path === '/_aliases') publications.push(path);
      if (method === 'PUT' && path === `/${index}/_mapping`) publications.push(path);
      const response = await native.request<T>(method, path, body, options);
      if (method !== 'POST' || path !== `/${index}/_search`) return response;
      expect(body).toEqual({ size: 0, aggs: { partitions: { terms: { field: 'partition', size: 4096 } } } });
      const genuine = structuredClone(response.body) as Reply;
      replies.push(genuine);
      expect(genuine.timed_out).toBe(false);
      expect(genuine._shards).toMatchObject({ total: 1, successful: 1, failed: 0 });
      expect(genuine.aggregations.partitions.buckets).toBeArray();
      // Exactly one native reconciliation response may be corrupted. Everything else is forwarded unchanged.
      expect(replies).toHaveLength(1);
      if (!fault) return response;
      const changed = structuredClone(genuine);
      fault.change(changed);
      expect(changed.hits).toEqual(genuine.hits);
      if (!['timed_out', 'incomplete shards', 'failed shards', 'terminated_early'].includes(fault.name)) {
        expect(changed._shards).toEqual(genuine._shards);
        expect(changed.timed_out).toBe(genuine.timed_out);
        expect(changed.terminated_early).toBe(genuine.terminated_early);
      } else {
        expect(changed.aggregations).toEqual(genuine.aggregations);
      }
      return { ...response, body: changed as T };
    },
  };
  return { client, replies, publications };
}

for (const fault of faults) {
  test(`native rebuild rejects incomplete or malformed reconciliation replies before changing the active alias: ${fault.name}`, async () => {
    // Real Source emptiness is a negative control: even true zero cannot admit a corrupt engine reply.
    const totals = await admin.query<{ visible: string }>(
      'SELECT coalesce(sum(visible), 0)::text AS visible FROM semantic.partition_subjects',
    );
    expect(totals.rows[0]!.visible).toBe('0');
    await deployment(async (prefix, runner) => {
      const observed = intercept(prefix, fault);
      const counted: number[] = [];
      const checkedSource: SubjectSource = {
        read: source.read.bind(source),
        async count(partition) {
          const actual = await source.count(partition);
          expect(actual.count).toBe(0);
          counted.push(partition);
          return actual;
        },
      };
      // The count seam only observes real native counts; it is never a Source completeness certificate.
      const outcome = await rebuildSubjects({
        pool,
        search: observed.client,
        source: checkedSource,
        prefix,
        runner,
        pollMs: 20,
        rounds: 1,
      }).then(
        (value) => ({ completed: true, value, error: undefined }),
        (error: unknown) => ({ completed: false, value: undefined, error }),
      );
      expect(observed.replies).toHaveLength(1);
      expect(observed.replies[0]!.aggregations.partitions.buckets).toEqual([]);
      expect(observed.replies[0]!.hits.total.value).toBe(0);
      expect(new Set(counted).size).toBe(counted.length);
      const actualAlias = await native.request<Record<string, unknown>>('GET', `/_alias/${subjectAlias(prefix)}`);
      const mapping = await native.request<Record<string, { mappings: { _meta?: { activated_at?: string } } }>>(
        'GET',
        `/${subjectIndexName(prefix, 2)}/_mapping`,
      );
      // Inspect errors without putting the intercepted payload in assertion output or operator diagnostics.
      const diagnostics = Bun.inspect(outcome.error, { depth: 10 });
      expect(diagnostics.includes(hidden)).toBe(false);
      expect({
        activeIndices: Object.keys(actualAlias.body),
        completed: outcome.completed,
        typedFailure: outcome.error instanceof SearchUnavailableError || outcome.error instanceof RebuildError,
        publications: observed.publications,
        activated: mapping.body[subjectIndexName(prefix, 2)]!.mappings._meta?.activated_at,
      }).toEqual({
        activeIndices: [subjectIndexName(prefix, 1)],
        completed: false,
        typedFailure: true,
        publications: [],
        activated: undefined,
      });
    });
  }, 60_000);
}

test('native rebuild accepts a successful empty native index', async () => {
  await deployment(async (prefix, runner) => {
    const observed = intercept(prefix);
    expect(
      await rebuildSubjects({ pool, search: observed.client, source, prefix, runner, pollMs: 20, rounds: 1 }),
    ).toEqual({ generation: 2, previous: 1 });
    expect(observed.replies).toHaveLength(1);
    expect(observed.replies[0]!.aggregations.partitions.buckets).toEqual([]);
    expect(await subjectGenerations(native, prefix)).toEqual({ generations: [1, 2], active: 2 });
  });
}, 60_000);

test('native rebuild retains successful bounded reconciliation with real Source and a physical generation', async () => {
  const fixture = await identityFixture(pool, admin);
  const id = await fixture.create(0x6e10, 'Native bounded reconciliation');
  await deployment(async (prefix, runner) => {
    const observed = intercept(prefix);
    const counted: number[] = [];
    const checkedSource: SubjectSource = {
      async read(partition, ids) {
        expect(ids.length).toBeLessThanOrEqual(256);
        return source.read(partition, ids);
      },
      async count(partition) {
        counted.push(partition);
        return source.count(partition);
      },
    };
    expect(
      await rebuildSubjects({
        pool,
        search: observed.client,
        source: checkedSource,
        prefix,
        runner,
        pollMs: 20,
        rounds: 1,
      }),
    ).toEqual({ generation: 2, previous: 1 });
    expect(observed.replies).toHaveLength(1);
    expect(observed.replies[0]!.aggregations.partitions.buckets).toEqual([{ key: 0x6e1, doc_count: 1 }]);
    const partitions = await admin.query<{ partition_no: number }>(
      'SELECT partition_no FROM core.partition WHERE position > 0 ORDER BY partition_no',
    );
    expect([...counted].sort((a, b) => a - b)).toEqual(partitions.rows.map((row) => row.partition_no));
    expect(new Set(counted).size).toBe(counted.length);
    expect(await subjectGenerations(native, prefix)).toEqual({ generations: [1, 2], active: 2 });
    const indexed = await native.request<{ _id: string; _index: string; found: boolean }>(
      'GET',
      `/${subjectIndexName(prefix, 2)}/_doc/${id}`,
    );
    expect(indexed.body).toMatchObject({ _id: id, _index: subjectIndexName(prefix, 2), found: true });
  });
}, 60_000);
