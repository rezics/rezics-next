import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
const prefixes: string[] = [];
afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(search, prefix);
    for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  await pool.end();
  await admin.end();
});

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
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

async function checkpoints(consumer: string): Promise<number> {
  const { rows } = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM core.consumer_checkpoint WHERE consumer = $1',
    [consumer],
  );
  return rows[0]!.count;
}

async function count(index: string): Promise<number> {
  return (await search.request<{ count: number }>('GET', `/${index}/_count`)).body.count;
}

async function activatedAt(prefix: string, generation: number): Promise<unknown> {
  const index = subjectIndexName(prefix, generation);
  const { body } = await search.request<Record<string, { mappings: { _meta?: { activated_at?: unknown } } }>>(
    'GET',
    `/${index}/_mapping`,
  );
  return body[index]?.mappings._meta?.activated_at;
}

/** Switches the alias to `generation` as a rebuild does, recording `at` unless it is null. */
async function activate(prefix: string, generation: number, at: Date | null = new Date()): Promise<void> {
  const index = subjectIndexName(prefix, generation);
  if (at) await search.request('PUT', `/${index}/_mapping`, { _meta: { activated_at: at.toISOString() } });
  const { active } = await subjectGenerations(search, prefix);
  const alias = subjectAlias(prefix);
  await search.request('POST', '/_aliases', {
    actions: [{ remove: { index: subjectIndexName(prefix, active!), alias } }, { add: { index, alias } }],
  });
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(50);
  }
}

const generationsOf = async (prefix: string) => (await subjectGenerations(search, prefix)).generations;

/** A deployment with its own prefix and runner, whose `subject` is indexed in generations 1 and 2. */
async function deployment(subject: IndexedSubject, retireAfterMs: number) {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  const fake = createFakeSource();
  const runner = await startSearchIndexing({
    pool,
    search,
    source: fake,
    prefix,
    intervalMs: 20,
    discoverMs: 50,
    retireAfterMs,
  });
  fake.put(subject);
  await append(subject.id);
  await createSubjectIndex(search, prefix, 2);
  await runner.refresh();
  await eventually(async () => (await count(subjectIndexName(prefix, 2))) === 1);
  await eventually(async () => (await count(subjectIndexName(prefix, 1))) === 1);
  return { prefix, fake, runner };
}

test('an older generation is retired after the grace period with its checkpoints, and the active one keeps indexing', async () => {
  const { prefix, fake, runner } = await deployment(book(500, 1), 300);
  try {
    expect(await activatedAt(prefix, 1)).toMatch(RFC3339);
    expect(await checkpoints(subjectConsumer(prefix, 1))).toBeGreaterThan(0);
    await activate(prefix, 2);
    await eventually(async () => (await generationsOf(prefix)).join() === '2');
    expect(await checkpoints(subjectConsumer(prefix, 1))).toBe(0);
    expect(await checkpoints(subjectConsumer(prefix, 2))).toBeGreaterThan(0);
    const later = book(500, 2);
    fake.put(later);
    await append(later.id);
    await eventually(async () => (await count(subjectIndexName(prefix, 2))) === 2);
    await Bun.sleep(300);
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [2], active: 2 });
    expect(await checkpoints(subjectConsumer(prefix, 1))).toBe(0);
  } finally {
    await runner.stop();
  }
});

test('generations stay while within the grace period, newer than the alias, or while the alias has no activation time', async () => {
  const graced = await deployment(book(510, 1), 60_000);
  try {
    await activate(graced.prefix, 2);
    await createSubjectIndex(search, graced.prefix, 3);
    await graced.runner.refresh();
    await Bun.sleep(300);
    expect(await generationsOf(graced.prefix)).toEqual([1, 2, 3]);
  } finally {
    await graced.runner.stop();
  }
  const untimed = await deployment(book(511, 1), 0);
  try {
    await activate(untimed.prefix, 2, null);
    await Bun.sleep(300);
    expect(await generationsOf(untimed.prefix)).toEqual([1, 2]);
    await search.request('PUT', `/${subjectIndexName(untimed.prefix, 2)}/_mapping`, {
      _meta: { activated_at: new Date().toISOString() },
    });
    await eventually(async () => (await generationsOf(untimed.prefix)).join() === '2');
  } finally {
    await untimed.runner.stop();
  }
});

test('a runner started after the grace period retires at its first discovery', async () => {
  const { prefix, fake, runner } = await deployment(book(520, 1), 60 * 60_000);
  await activate(prefix, 2, new Date(Date.now() - 20 * 60_000));
  await Bun.sleep(200);
  await runner.stop();
  expect(await generationsOf(prefix)).toEqual([1, 2]);
  const restarted = await startSearchIndexing({ pool, search, source: fake, prefix, intervalMs: 20, discoverMs: 50 });
  try {
    await eventually(async () => (await generationsOf(prefix)).join() === '2');
    expect(await checkpoints(subjectConsumer(prefix, 1))).toBe(0);
  } finally {
    await restarted.stop();
  }
});
