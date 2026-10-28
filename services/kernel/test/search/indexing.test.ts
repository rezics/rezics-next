import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { documentActions } from '../../src/search/document.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';
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

function freshPrefix(): string {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  return prefix;
}

async function freshIndex(): Promise<string> {
  const prefix = freshPrefix();
  await createSubjectIndex(search, prefix, 1);
  return subjectIndexName(prefix, 1);
}

// Every test uses its own partitions, so their logs never meet.
const id = (partition: number, n: number) =>
  `018f0000-0000-7000-8000-${(partition * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`;
const book = (partition: number, n: number): IndexedSubject => ({
  id: id(partition, n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});

/** Appends one envelope naming `subject`, as the fence does. */
async function append(partition: number, subject: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, 'com.rezics.subject.created.v1', $5, jsonb_build_object('id', $5::text))`,
      [partition, rows[0]!.position, rows[0]!.epoch, crypto.randomUUID(), subject],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkpoint(consumer: string, partition: number): Promise<string | null> {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no = $1 AND consumer = $2',
    [partition, consumer],
  );
  return rows[0]?.position ?? null;
}

async function exists(index: string, subject: string): Promise<boolean> {
  try {
    await search.request('GET', `/${index}/_doc/${subject}`);
    return true;
  } catch (error) {
    if (error instanceof OpenSearchError && error.status === 404) return false;
    throw error;
  }
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(50);
  }
}

function counted(source: SubjectSource) {
  const reads: string[][] = [];
  const wrapped: SubjectSource = {
    read: (partition, ids) => {
      reads.push([...ids]);
      return source.read(partition, ids);
    },
    count: (partition) => source.count(partition),
  };
  return { reads, source: wrapped };
}

function countingSearch(inner: OpenSearch) {
  const bulks: number[] = [];
  const wrapped = {
    request: ((...args: Parameters<OpenSearch['request']>) => inner.request(...args)) as OpenSearch['request'],
    bulk: ((lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) => {
      bulks.push(lines.length);
      return inner.bulk(lines, options);
    }) as OpenSearch['bulk'],
  };
  return { bulks, search: wrapped };
}

test('a batch indexes each named subject once from one snapshot at the partition position', async () => {
  const index = await freshIndex();
  const fake = createFakeSource();
  const a = book(101, 1);
  const b = book(101, 2);
  fake.put(a);
  fake.put(b);
  for (const subject of [a.id, b.id, a.id]) await append(101, subject);
  const reads = counted(fake);
  const writes = countingSearch(search);
  const relay = createSubjectIndexer({
    pool,
    search: writes.search,
    source: reads.source,
    listing: emptyListing,
    index,
    consumer: 'search_one',
  });
  expect(relay.consumer).toBe('search_one');
  expect(await relay.run(101)).toMatchObject({ status: 'read', envelopes: 3 });
  expect(reads.reads).toEqual([[a.id, b.id]]);
  expect(writes.bulks).toEqual([4]);
  const snapshot = await fake.read(101, [a.id]);
  const stored = await search.request<{ _version: number; _source: unknown }>('GET', `/${index}/_doc/${a.id}`);
  expect(stored.body._version).toBe(Number(snapshot.position));
  expect(stored.body._source).toEqual({
    ...(documentActions(snapshot, [a.id], new Map())[0] as { document: Record<string, unknown> }).document,
    name_sort: 'book 1',
  });
  expect(await checkpoint('search_one', 101)).toBe('3');
  expect(await relay.run(101)).toMatchObject({ status: 'read', envelopes: 0 });
  expect(reads.reads).toHaveLength(1);
});

test('a later takedown deletes the document and replays are harmless', async () => {
  const index = await freshIndex();
  const fake = createFakeSource();
  const a = book(102, 1);
  fake.put(a);
  await append(102, a.id);
  const relay = createSubjectIndexer({
    pool,
    search,
    source: fake,
    listing: emptyListing,
    index,
    consumer: 'search_two',
  });
  await relay.run(102);
  expect(await exists(index, a.id)).toBe(true);
  fake.put({ ...a, visibility: 'taken_down', securityRevision: 2 });
  await append(102, a.id);
  expect(await relay.run(102)).toMatchObject({ status: 'read', envelopes: 1 });
  expect(await exists(index, a.id)).toBe(false);
  await admin.query(
    "UPDATE core.consumer_checkpoint SET position = 0, epoch = NULL WHERE consumer = 'search_two' AND partition_no = 102",
  );
  expect(await relay.run(102)).toMatchObject({ status: 'read', envelopes: 2 });
  expect(await exists(index, a.id)).toBe(false);
  fake.put({ ...a, securityRevision: 3 });
  await append(102, a.id);
  await relay.run(102);
  expect(await exists(index, a.id)).toBe(true);
});

test('write and read failures leave the checkpoint where it was', async () => {
  const index = await freshIndex();
  const fake = createFakeSource();
  const a = book(103, 1);
  fake.put(a);
  await append(103, a.id);
  const relay = createSubjectIndexer({
    pool,
    search,
    source: fake,
    listing: emptyListing,
    index,
    consumer: 'search_three',
  });
  await search.request('POST', `/${index}/_close`);
  await expect(relay.run(103)).rejects.toThrow();
  expect(await checkpoint('search_three', 103)).toBe('0');
  await search.request('POST', `/${index}/_open`);
  const failing: SubjectSource = {
    read: () => Promise.reject(new Error('partition unavailable')),
    count: (partition) => fake.count(partition),
  };
  const broken = createSubjectIndexer({
    pool,
    search,
    source: failing,
    listing: emptyListing,
    index,
    consumer: 'search_three',
  });
  await expect(broken.run(103)).rejects.toThrow('partition unavailable');
  expect(await checkpoint('search_three', 103)).toBe('0');
  expect(await relay.run(103)).toMatchObject({ status: 'read', envelopes: 1 });
  expect(await checkpoint('search_three', 103)).toBe('1');
  expect(await exists(index, a.id)).toBe(true);
});

test('subjects named from another partition are skipped', async () => {
  const index = await freshIndex();
  const fake = createFakeSource();
  const foreign = book(105, 1);
  fake.put(foreign);
  await append(104, foreign.id);
  const reads = counted(fake);
  const writes = countingSearch(search);
  const relay = createSubjectIndexer({
    pool,
    search: writes.search,
    source: reads.source,
    listing: emptyListing,
    index,
    consumer: 'search_four',
  });
  expect(await relay.run(104)).toMatchObject({ status: 'read', envelopes: 1 });
  expect(reads.reads).toEqual([]);
  expect(writes.bulks).toEqual([]);
  expect(await checkpoint('search_four', 104)).toBe('1');
  expect(await exists(index, foreign.id)).toBe(false);
});

test('cost per batch is one snapshot read and one bulk request at every batch size', async () => {
  const index = await freshIndex();
  for (const [partition, size] of [
    [106, 1],
    [107, 8],
    [108, 64],
  ] as const) {
    const fake = createFakeSource();
    for (let n = 1; n <= size; n += 1) {
      fake.put(book(partition, n));
      await append(partition, id(partition, n));
    }
    const reads = counted(fake);
    const writes = countingSearch(search);
    const relay = createSubjectIndexer({
      pool,
      search: writes.search,
      source: reads.source,
      listing: emptyListing,
      index,
      consumer: 'search_cost',
    });
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: size });
    expect({ size, reads: reads.reads.length, bulks: writes.bulks }).toEqual({ size, reads: 1, bulks: [2 * size] });
  }
});

test('the runner creates the first generation, feeds every generation and follows pause and new generations', async () => {
  const prefix = freshPrefix();
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
  try {
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1], active: 1 });
    expect(subjectConsumer('rezics-', 1)).toBe('search_rezics_subjects_g1');
    expect(() => subjectConsumer(`${'a'.repeat(48)}`, 1)).toThrow(RangeError);
    const a = book(110, 1);
    fake.put(a);
    await append(110, a.id);
    await eventually(() => exists(subjectIndexName(prefix, 1), a.id));
    await createSubjectIndex(search, prefix, 2);
    await runner.refresh();
    await eventually(() => exists(subjectIndexName(prefix, 2), a.id));
    await eventually(async () => (await checkpoint(subjectConsumer(prefix, 2), 110)) === '1');
    await runner.pause();
    const b = book(110, 2);
    fake.put(b);
    await append(110, b.id);
    await Bun.sleep(300);
    expect(await exists(subjectIndexName(prefix, 1), b.id)).toBe(false);
    runner.resume();
    await eventually(() => exists(subjectIndexName(prefix, 1), b.id));
    await eventually(() => exists(subjectIndexName(prefix, 2), b.id));
  } finally {
    await runner.stop();
  }
});
