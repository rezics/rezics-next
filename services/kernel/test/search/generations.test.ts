import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { RebuildError, rebuildSubjects } from '../../src/search/generations.ts';
import {
  createSubjectIndex,
  MAX_SUBJECT_GENERATIONS,
  readSubjectSortFormat,
  subjectAlias,
  subjectIndexDefinition,
  subjectGenerations,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';
import { captureMetadata, mappingControls, resolveControls } from './support/native-metadata.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
const emptyListing = {
  async read() {
    return new Map<string, number>();
  },
};
const prefixes: string[] = [];
afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(search, prefix);
    for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  await pool.end();
  await admin.end();
});

// Every test uses its own partitions. Its envelopes reach the other tests' consumers, whose sources do not know them.
const book = (partition: number, n: number): IndexedSubject => ({
  id: `018f0000-0000-7000-8000-${(partition * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});

/** Appends one envelope naming `subject` in its partition, as the fence does. */
async function append(subject: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [subjectPartition(subject)],
    );
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, 'com.rezics.subject.created.v1', $5, jsonb_build_object('id', $5::text))`,
      [subjectPartition(subject), rows[0]!.position, rows[0]!.epoch, crypto.randomUUID(), subject],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function count(index: string): Promise<number> {
  return (await search.request<{ count: number }>('GET', `/${index}/_count`)).body.count;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(50);
  }
}

/** A deployment with its own prefix and runner, whose `subjects` were written and indexed in generation 1. */
async function deployment(subjects: readonly IndexedSubject[]) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const fake = createFakeSource();
  const runner = await startSearchIndexing({
    pool,
    search,
    source: fake,
    listing: emptyListing,
    prefix,
    intervalMs: 20,
    discoverMs: 50,
  });
  for (const subject of subjects) {
    fake.put(subject);
    await append(subject.id);
  }
  await eventually(async () => (await count(subjectIndexName(prefix, 1))) === subjects.length);
  return { prefix, fake, runner };
}

test('a rebuild replays the log into a new generation, reconciles every partition and switches the alias', async () => {
  const { prefix, fake, runner } = await deployment([book(300, 1), book(300, 2), book(301, 1)]);
  try {
    expect(await rebuildSubjects({ pool, search, source: fake, prefix, runner, pollMs: 20 })).toEqual({
      generation: 2,
      previous: 1,
    });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 2 });
    expect(await count(subjectIndexName(prefix, 2))).toBe(3);
    const later = book(301, 2);
    fake.put(later);
    await append(later.id);
    await eventually(async () => (await count(subjectIndexName(prefix, 2))) === 4);
    await eventually(async () => (await count(subjectIndexName(prefix, 1))) === 4);
  } finally {
    await runner.stop();
  }
});

test('a partition whose index disagrees with its source fails the rebuild and keeps the alias, and the next rebuild resumes that generation', async () => {
  const { prefix, fake, runner } = await deployment([book(310, 1)]);
  try {
    const stray = book(310, 2);
    // Committed without an envelope, so no generation hears of it.
    fake.put(stray);
    const failure = await rebuildSubjects({ pool, search, source: fake, prefix, runner, pollMs: 20 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RebuildError);
    expect(failure).toMatchObject({
      reason: 'mismatch',
      generation: 2,
      partitions: [{ partition: 310, indexed: 1, source: 2 }],
    });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 1 });
    await append(stray.id);
    expect(await rebuildSubjects({ pool, search, source: fake, prefix, runner, pollMs: 20 })).toEqual({
      generation: 2,
      previous: 1,
    });
    expect(await count(subjectIndexName(prefix, 2))).toBe(2);
  } finally {
    await runner.stop();
  }
});

test('a partition written during reconciliation is compared once it is quiet', async () => {
  const { prefix, fake, runner } = await deployment([book(320, 1)]);
  try {
    let written = false;
    let counted = 0;
    const source: SubjectSource = {
      read: (partition, ids) => fake.read(partition, ids),
      count: async (partition) => {
        if (partition === 320) {
          counted += 1;
          if (!written) {
            written = true;
            const extra = book(320, 2);
            fake.put(extra);
            await append(extra.id);
          }
        }
        return fake.count(partition);
      },
    };
    expect(await rebuildSubjects({ pool, search, source, prefix, runner, pollMs: 20, rounds: 50 })).toEqual({
      generation: 2,
      previous: 1,
    });
    expect(counted).toBeGreaterThan(1);
    expect(await count(subjectIndexName(prefix, 2))).toBe(2);
  } finally {
    await runner.stop();
  }
});

test('a rebuild that cannot catch up in time fails without switching', async () => {
  const { prefix, fake, runner } = await deployment([book(330, 1)]);
  try {
    await runner.pause();
    const failure = await rebuildSubjects({
      pool,
      search,
      source: fake,
      prefix,
      runner,
      pollMs: 20,
      timeoutMs: 300,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RebuildError);
    expect(failure).toMatchObject({ reason: 'timeout', generation: 2, partitions: [] });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 1 });
  } finally {
    await runner.stop();
  }
});

test('each reconciliation round reads every non-empty partition count once and makes one index aggregation', async () => {
  for (const [scale, base] of [
    [1, 400],
    [4, 410],
    [16, 420],
  ] as const) {
    const { prefix, fake, runner } = await deployment(Array.from({ length: scale }, (_, n) => book(base + n, 1)));
    try {
      const counted: number[] = [];
      let searches = 0;
      const source: SubjectSource = {
        read: (partition, ids) => fake.read(partition, ids),
        count: (partition) => {
          counted.push(partition);
          return fake.count(partition);
        },
      };
      const client: OpenSearch = {
        request: ((...args: Parameters<OpenSearch['request']>) => {
          if (args[1].endsWith('/_search')) searches += 1;
          return search.request(...args);
        }) as OpenSearch['request'],
        bulk: ((...args: Parameters<OpenSearch['bulk']>) => search.bulk(...args)) as OpenSearch['bulk'],
      };
      await rebuildSubjects({ pool, search: client, source, prefix, runner, pollMs: 20 });
      const { rows } = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM core.partition WHERE position > 0',
      );
      expect({ scale, searches, counted: counted.length }).toEqual({ scale, searches: 1, counted: rows[0]!.count });
      expect(new Set(counted).size).toBe(counted.length);
    } finally {
      await runner.stop();
    }
  }
});

test('native metadata admits absent, initial, rebuilding, switched and retired sets with one bounded observation as unrelated indices grow', async () => {
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const unrelated: string[] = [];
  const receipts: unknown[] = [];
  async function observe(generations: number[], active: number | null) {
    const { client, calls } = captureMetadata(search, 'resolve');
    expect(await subjectGenerations(client, prefix)).toEqual({ generations, active });
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: `/_resolve/index/${prefix}subjects*` },
    ]);
    receipts.push(calls[0]!.raw);
  }
  try {
    await observe([], null);
    await createSubjectIndex(search, prefix, 1);
    await observe([1], null);
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    await observe([1], 1);
    await createSubjectIndex(search, prefix, 2);
    await observe([1, 2], 1);
    await createSubjectIndex(search, prefix, 3);
    await search.request('PUT', `/${subjectIndexName(prefix, 3)}/_settings`, { index: { hidden: true } });
    expect(MAX_SUBJECT_GENERATIONS).toBe(3);
    for (const population of [1, 4, 16]) {
      while (unrelated.length < population) {
        const other = `unrelated-${crypto.randomUUID().slice(0, 8)}-`;
        await createSubjectIndex(search, other, 1);
        unrelated.push(subjectIndexName(other, 1));
      }
      await observe([1, 2, 3], 1);
      console.info(
        'native metadata growth',
        JSON.stringify({ population, resolve: 1, mapping: 0, writes: 0, source: 0, receipt: receipts.at(-1) }),
      );
    }
    await search.request('POST', '/_aliases', {
      actions: [
        { remove: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } },
        { add: { index: subjectIndexName(prefix, 2), alias: subjectAlias(prefix) } },
      ],
    });
    await observe([1, 2, 3], 2);
    await search.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
    await observe([2, 3], 2);
    // A generation need not be contiguous or fit in a 32-bit integer.
    await createSubjectIndex(search, prefix, Number.MAX_SAFE_INTEGER);
    await observe([2, 3, Number.MAX_SAFE_INTEGER], 2);
    await search.request('POST', '/_aliases', {
      actions: [
        { remove: { index: subjectIndexName(prefix, 2), alias: subjectAlias(prefix) } },
        { add: { index: subjectIndexName(prefix, Number.MAX_SAFE_INTEGER), alias: subjectAlias(prefix) } },
      ],
    });
    await observe([2, 3, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER);
    console.info('native metadata lifecycle', JSON.stringify(receipts));
  } finally {
    for (const index of unrelated) await search.request('DELETE', `/${index}`);
  }
}, 120_000);

test('malformed native resolve receipts reject reads and rebuild admission without writes or Source work', async () => {
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  await createSubjectIndex(search, prefix, 1);
  await createSubjectIndex(search, prefix, 2);
  await search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  const fake = createFakeSource();
  let sourceWork = 0,
    refreshes = 0;
  const source: SubjectSource = {
    read: (...args) => {
      sourceWork++;
      return fake.read(...args);
    },
    count: (...args) => {
      sourceWork++;
      return fake.count(...args);
    },
  };
  for (const control of resolveControls(prefix)) {
    for (const transition of [false, true]) {
      const { client, calls } = captureMetadata(search, 'resolve', control);
      const result = transition
        ? rebuildSubjects({
            pool,
            search: client,
            source,
            prefix,
            runner: {
              async refresh() {
                refreshes++;
              },
            },
          })
        : subjectGenerations(client, prefix);
      await expect(result, control.name).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(
        calls.map(({ method, path }) => ({ method, path })),
        control.name,
      ).toEqual([{ method: 'GET', path: `/_resolve/index/${prefix}subjects*` }]);
      expect(calls[0]!.raw).toMatchObject({
        status: 200,
        body: {
          indices: [
            { name: subjectIndexName(prefix, 1), attributes: ['open'], aliases: [subjectAlias(prefix)] },
            { name: subjectIndexName(prefix, 2), attributes: ['open'] },
          ],
          aliases: [{ name: subjectAlias(prefix), indices: [subjectIndexName(prefix, 1)] }],
          data_streams: [],
        },
      });
    }
  }
  expect({ sourceWork, refreshes }).toEqual({ sourceWork: 0, refreshes: 0 });
}, 120_000);

test('native mapping receipts bind exactly one generation and malformed receipts cannot resume a rebuild', async () => {
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  await createSubjectIndex(search, prefix, 1);
  await createSubjectIndex(search, prefix, 2);
  await search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  const index = subjectIndexName(prefix, 2);
  const { client, calls } = captureMetadata(search, 'mapping');
  expect(await readSubjectSortFormat(client, prefix, 2)).toBe(1);
  expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([{ method: 'GET', path: `/${index}/_mapping` }]);
  console.info('native mapping baseline', JSON.stringify(calls));
  for (const control of mappingControls(index)) {
    for (const transition of [false, true]) {
      const { client, calls } = captureMetadata(search, 'mapping', control);
      let sourceWork = 0,
        refreshes = 0;
      const fake = createFakeSource();
      const source: SubjectSource = {
        read: (...args) => {
          sourceWork++;
          return fake.read(...args);
        },
        count: (...args) => {
          sourceWork++;
          return fake.count(...args);
        },
      };
      const result = transition
        ? rebuildSubjects({
            pool,
            search: client,
            source,
            prefix,
            runner: {
              async refresh() {
                refreshes++;
              },
            },
          })
        : readSubjectSortFormat(client, prefix, 2);
      await expect(result, control.name).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(
        calls.map(({ method, path }) => ({ method, path })),
        control.name,
      ).toEqual([
        ...(transition ? [{ method: 'GET', path: `/_resolve/index/${prefix}subjects*` }] : []),
        { method: 'GET', path: `/${index}/_mapping` },
      ]);
      expect({ sourceWork, refreshes }).toEqual({ sourceWork: 0, refreshes: 0 });
    }
  }
  // Genuine legacy/unsupported formats are unavailable to query callers but
  // remain a successful null format observation, rather than corrupt metadata.
  for (const meta of [{}, { name_sort_format: 0 }, { name_sort_format: 2 }]) {
    await search.request('PUT', `/${index}/_mapping`, { _meta: meta });
    expect(await readSubjectSortFormat(search, prefix, 2)).toBeNull();
  }
  const legacy = structuredClone(subjectIndexDefinition()) as { mappings: { _meta?: unknown } };
  delete legacy.mappings._meta;
  await search.request('PUT', `/${subjectIndexName(prefix, 3)}`, legacy);
  expect(await readSubjectSortFormat(search, prefix, 3)).toBeNull();
  await expect(readSubjectSortFormat(search, prefix, 77)).rejects.toBeInstanceOf(SearchUnavailableError);
}, 120_000);
