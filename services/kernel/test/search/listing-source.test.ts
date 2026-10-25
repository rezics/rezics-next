import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { routeOf } from '../../src/route/route.ts';
import { documentActions } from '../../src/search/document.ts';
import { subjectIndexDefinition } from '../../src/search/indices.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the check database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
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

test('indexed documents carry the public collection count when counts are given', () => {
  const definition = subjectIndexDefinition() as { mappings: { properties: Record<string, unknown> } };
  expect(definition.mappings.properties.public_collection_count).toEqual({ type: 'integer' });
  const [a, b, hidden] = [book(124, 1), book(124, 2), book(124, 3, { visibility: 'hidden' })];
  const snapshot = { partition: 124, position: 5n, subjects: [a, b, hidden] };
  const ids = [a.id, b.id, hidden.id];
  const shown = (counts?: Map<string, number>) =>
    documentActions(snapshot, ids, counts).map((action) =>
      action.op === 'index' ? action.document.public_collection_count : action.op,
    );
  expect(shown(new Map([[a.id, 3]]))).toEqual([3, 0, 'delete']);
  expect(shown()).toEqual([undefined, undefined, 'delete']);
});

test("the production listing source reads counts in the subject's partition", async () => {
  const [a, b] = [id(122, 1), id(122, 2)];
  await admin.query(
    `INSERT INTO library.subject_listing (route, subject_id, public_collection_count, revision, updated_at, transaction_id)
     VALUES ($1, $2, 4, 1, now(), gen_random_uuid())
     ON CONFLICT (route, subject_id) DO UPDATE SET public_collection_count = 4`,
    [routeOf(a), a],
  );
  const listing = subjectListingSource(pool);
  expect(await listing.read(122, [a, b])).toEqual(new Map([[a, 4]]));
  expect(await listing.read(122, [b])).toEqual(new Map());
  expect(await listing.read(122, [])).toEqual(new Map());
  await expect(listing.read(123, [a])).rejects.toThrow(RangeError);
});
