import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { RebuildError, rebuildSubjects } from '../../src/search/generations.ts';
import { subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

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
