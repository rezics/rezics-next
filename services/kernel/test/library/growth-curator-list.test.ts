import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { createCollectionReads } from '../../src/library/collection-reads.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x5c32;
const curator: AccountActor = {
  kind: 'account',
  accountId: newId(route),
  clientId: 'web',
  scopes: ['collection:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const other: AccountActor = { ...curator, accountId: newId(route) };
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
let db: GrowthDatabase;
let reads: ReturnType<typeof createCollectionReads>;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  reads = createCollectionReads({
    pool: db.pool,
    access: createAccess({ actions: new Map([['collection:read', { anonymous: true }]]) }),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(12)]]) },
  });
  await db.admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     SELECT $1, id, 'actor', 'active', id, false, 1, true FROM unnest($2::uuid[]) AS id`,
    [route, [curator.accountId, other.accountId]],
  );
});

beforeEach(async () => {
  await db.admin.query('DELETE FROM library.collection WHERE route = $1 AND curator_account_id = $2', [
    route,
    curator.accountId,
  ]);
});

afterAll(async () => {
  await db?.close();
});

function anchorId(ordinal: number): string {
  return `10000000-0000-7000-8000-5c32${ordinal.toString(16).padStart(8, '0')}`;
}

async function grow(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  if (previous === 0) {
    await database.admin.query('DELETE FROM library.collection WHERE route = $1 AND curator_account_id = $2', [
      route,
      curator.accountId,
    ]);
    // A fixed public prefix keeps both pages full even at the smallest scale. Equal timestamps exercise id ties.
    await database.admin.query(
      `INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, visibility, state, revision, created_at, updated_at, transaction_id)
       SELECT $1, id, $2, 'Public anchor', 'public', 'active', 1,
              '2026-05-01'::timestamptz, '2026-05-01'::timestamptz, id
       FROM (
         SELECT ('10000000-0000-7000-8000-5c32' || lpad(to_hex(n), 8, '0'))::uuid AS id
         FROM generate_series(1, 48) AS n
       ) AS source`,
      [route, curator.accountId],
    );
  }
  // One quarter of the growing population is each kind; hidden rows sort ahead of the fixed public pages.
  await database.admin.query(
    `INSERT INTO library.collection
       (route, collection_id, curator_account_id, title, visibility, state, revision, created_at, updated_at, transaction_id)
     SELECT $1, id, $2, 'Growing Collection',
            CASE n % 4 WHEN 1 THEN 'unlisted' WHEN 2 THEN 'private' ELSE 'public' END,
            CASE WHEN n % 4 = 3 THEN 'deleted' ELSE 'active' END, 1,
            '2026-01-01'::timestamptz,
            CASE WHEN n % 4 = 0 THEN '2026-01-01'::timestamptz ELSE '2026-06-01'::timestamptz END, id
     FROM (
       SELECT n, ('20000000-0000-7000-8000-5c32' || lpad(to_hex(n), 8, '0'))::uuid AS id
       FROM generate_series($3::int + 1, $4::int) AS n
     ) AS source`,
    [route, curator.accountId, previous, scale],
  );
}

test("a curator's public Collection page examines a constant number of rows as the curator's private, unlisted and deleted Collections grow", async () => {
  for (const fromCursor of [false, true]) {
    let cursor: string | null = null;
    const report = await checkGrowth(db, {
      name: `Curator public ${fromCursor ? 'cursor' : 'first'} page`,
      scales: [64, 256, 1024],
      bounds,
      async grow(database, scale, previous) {
        await grow(database, scale, previous);
        if (fromCursor) {
          const first = await reads.listCollections(other, { curatorAccountId: curator.accountId, limit: 20 });
          expect(first.collections.map((collection) => collection.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => anchorId(48 - index)),
          );
          expect(first.next).toBeString();
          cursor = first.next;
        }
      },
      async operation() {
        const page = await reads.listCollections(other, { curatorAccountId: curator.accountId, limit: 20, cursor });
        expect(page.collections.map((collection) => collection.id)).toEqual(
          Array.from({ length: 20 }, (_, index) => anchorId((fromCursor ? 28 : 48) - index)),
        );
        expect(page.collections.every((collection) => collection.visibility === 'public')).toBe(true);
        expect(page.next).toBeString();
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 256, 1024]);
  }
}, 90_000);

test("a curator's own full Collection page examines a constant number of rows as the curator's deleted Collections grow", async () => {
  await checkGrowth(db, {
    name: 'Curator full first page',
    scales: [64, 256, 1024],
    bounds,
    grow,
    async operation(_database, scale) {
      const page = await reads.listCollections(curator, { curatorAccountId: curator.accountId, limit: 20 });
      const expected = Array.from({ length: scale }, (_, index) => scale - index)
        .filter((ordinal) => ordinal % 4 === 1 || ordinal % 4 === 2)
        .slice(0, 20)
        .map((ordinal) => `20000000-0000-7000-8000-5c32${ordinal.toString(16).padStart(8, '0')}`);
      expect(page.collections.map((collection) => collection.id)).toEqual(expected);
      expect(page.next).toBeString();
    },
  });
}, 90_000);
