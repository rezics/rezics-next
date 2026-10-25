import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject, SubjectListingSource, SubjectSource } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const search = createOpenSearch(searchUrl);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
afterAll(async () => {
  const { generations } = await subjectGenerations(search, prefix);
  for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  await pool.end();
  await admin.end();
});

const id = (partition: number, n: number) =>
  `018f0000-0000-7000-8000-${(partition * 16).toString(16).padStart(4, '0')}${String(n).padStart(8, '0')}`;
const book = (partition: number, n: number, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: id(partition, n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [],
  ...patch,
});

async function append(partition: number, subject: string, type: string, data: object): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    await client.query(
      `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
       VALUES ($1, $2, 0, 1, $3, $4, $5, $6, $7::jsonb)`,
      [partition, rows[0]!.position, rows[0]!.epoch, crypto.randomUUID(), type, subject, JSON.stringify(data)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function countOf(index: string, subject: string): Promise<unknown> {
  const { body } = await search.request<{ _source: Record<string, unknown> }>('GET', `/${index}/_doc/${subject}`);
  return body._source.public_collection_count;
}

test("a listed event refreshes the public collection count from the subject's partition", async () => {
  await createSubjectIndex(search, prefix, 1);
  const index = subjectIndexName(prefix, 1);
  const fake = createFakeSource();
  const [a, b, hidden] = [book(121, 1), book(121, 2), book(121, 3, { visibility: 'hidden' })];
  for (const subject of [a, b, hidden]) fake.put(subject);
  const calls: string[] = [];
  const counts = new Map([[a.id, 3]]);
  const source: SubjectSource = {
    read: (partition, ids) => {
      calls.push(`subjects ${ids.length}`);
      return fake.read(partition, ids);
    },
    count: (partition) => fake.count(partition),
  };
  const listing: SubjectListingSource = {
    async read(_partition, ids) {
      calls.push(`listing ${[...ids].sort().join(',')}`);
      return new Map([...counts].filter(([subject]) => ids.includes(subject)));
    },
  };
  const relay = createSubjectIndexer({ pool, search, source, listing, index, consumer: 'search_listing' });
  for (const subject of [a, b, hidden])
    await append(121, subject.id, 'com.rezics.subject.created.v1', { id: subject.id });
  await relay.run(121);
  expect(calls).toEqual(['subjects 3', `listing ${[a.id, b.id].sort().join(',')}`]);
  expect(await countOf(index, a.id)).toBe(3);
  expect(await countOf(index, b.id)).toBe(0);

  counts.set(b.id, 2);
  fake.advance(121);
  calls.length = 0;
  await append(121, b.id, 'com.rezics.library.subject.listed.v1', { subjectId: b.id });
  expect(await relay.run(121)).toMatchObject({ status: 'read', envelopes: 1 });
  expect(calls).toEqual(['subjects 1', `listing ${b.id}`]);
  expect(await countOf(index, b.id)).toBe(2);
  expect(await countOf(index, a.id)).toBe(3);

  fake.put({ ...b, visibility: 'hidden', securityRevision: 2 });
  calls.length = 0;
  await append(121, b.id, 'com.rezics.subject.visibility_changed.v1', {
    id: b.id,
    visibility: 'hidden',
    security_revision: 2,
  });
  await relay.run(121);
  expect(calls).toEqual(['subjects 1']);
});
