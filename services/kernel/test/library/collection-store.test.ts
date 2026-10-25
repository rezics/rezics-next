import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/collection-store.ts';
import type { CollectionDraft, CollectionMemberDraft } from '../../src/library/collection-model.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { withConnection } from '../../src/database/pool.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const route = 0x1234;
const time = '2026-10-26T04:00:00.000Z';
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const context = { transactionId: id(99), time };
const draft: CollectionDraft = {
  id: id(1),
  curatorAccountId: id(2),
  title: 'Reading list',
  description: 'A short list of subjects.',
  visibility: 'private',
};

async function fixture(body: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await store.insertCollection(client, route, draft, context);
    await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function member(n: number, ordinalKey: string, subjectId = id(50)): CollectionMemberDraft {
  return { id: id(n), subjectId, note: null, ordinalKey };
}

test('Collections round trip, list by curator, CAS revisions and tombstone', async () => {
  await fixture(async (client) => {
    const collection = (await store.readCollection(client, route, draft.id))!;
    expect(collection).toMatchObject({
      id: draft.id,
      curatorAccountId: draft.curatorAccountId,
      title: draft.title,
      description: draft.description,
      visibility: 'private',
      state: 'active',
      revision: 1,
      memberCount: 0,
      orderEpoch: 0,
    });
    expect(await store.readCollection(client, route + 1, draft.id)).toBeNull();
    expect(
      await store.listCuratorCollections(client, route, draft.curatorAccountId, {
        after: null,
        visibility: null,
        limit: 10,
      }),
    ).toEqual([collection]);
    expect(
      await store.listCuratorCollections(client, route, draft.curatorAccountId, {
        after: null,
        visibility: 'public',
        limit: 10,
      }),
    ).toEqual([]);

    const revised = await store.updateCollection(
      client,
      route,
      draft.id,
      1,
      { title: 'Updated list', description: null, visibility: 'unlisted' },
      { ...context, transactionId: id(98) },
    );
    expect(revised).toMatchObject({ title: 'Updated list', description: null, visibility: 'unlisted', revision: 2 });
    expect(
      await store.updateCollection(
        client,
        route,
        draft.id,
        1,
        { title: 'Stale write', description: null, visibility: 'public' },
        { ...context, transactionId: id(97) },
      ),
    ).toBeNull();
    expect(await store.readCollection(client, route, draft.id)).toEqual(revised);

    const deleted = await store.tombstoneCollection(client, route, draft.id, { ...context, transactionId: id(96) });
    expect(deleted).toMatchObject({ state: 'deleted', revision: 3 });
    expect(
      await store.listCuratorCollections(client, route, draft.curatorAccountId, {
        after: null,
        visibility: null,
        limit: 10,
      }),
    ).toEqual([]);
  });
});

test('members preserve duplicate subjects, move and page by their ordinal keys', async () => {
  await fixture(async (client) => {
    const subject = id(60);
    for (const row of [
      member(10, 'a000', subject),
      member(11, 'c000'),
      member(12, 'e000', subject),
      member(13, 'g000'),
      member(14, 'i000'),
    ]) {
      await store.insertMember(client, route, draft.id, row, context);
    }
    expect(await store.readMember(client, route, draft.id, id(10))).toMatchObject({
      id: id(10),
      collectionId: draft.id,
      subjectId: subject,
      ordinalKey: 'a000',
    });
    expect(await store.memberNeighbors(client, route, draft.id, { kind: 'first' })).toEqual({
      before: null,
      after: 'a000',
    });
    expect(await store.memberNeighbors(client, route, draft.id, { kind: 'after', memberId: id(10) })).toEqual({
      before: 'a000',
      after: 'c000',
    });
    expect(await store.memberNeighbors(client, route, draft.id, { kind: 'last' })).toEqual({
      before: 'i000',
      after: null,
    });

    await store.updateMemberNote(client, route, draft.id, id(11), 'A note', { ...context, transactionId: id(95) });
    expect(await store.readMember(client, route, draft.id, id(11))).toMatchObject({ note: 'A note' });
    await store.moveMember(client, route, draft.id, id(13), 'b000', { ...context, transactionId: id(94) });

    const first = await store.listMembers(client, route, draft.id, { after: null, limit: 2 });
    const second = await store.listMembers(client, route, draft.id, {
      after: { ordinalKey: first[1]!.ordinalKey, memberId: first[1]!.id },
      limit: 2,
    });
    const third = await store.listMembers(client, route, draft.id, {
      after: { ordinalKey: second[1]!.ordinalKey, memberId: second[1]!.id },
      limit: 2,
    });
    expect(first.map(({ id: memberId }) => memberId)).toEqual([id(10), id(13)]);
    expect(second.map(({ id: memberId }) => memberId)).toEqual([id(11), id(12)]);
    expect(third.map(({ id: memberId }) => memberId)).toEqual([id(14)]);
    expect(first[0]!.subjectId).toBe(second[1]!.subjectId);

    expect(
      await store.deleteMember(client, route, draft.id, id(14), { ...context, transactionId: id(93) }),
    ).toMatchObject({
      id: id(14),
    });
    expect(await store.readCollection(client, route, draft.id)).toMatchObject({ memberCount: 4 });
  });
});

test('respacing 500 members rewrites one Collection in one statement and preserves order', async () => {
  await fixture(async (client) => {
    await client.query(
      `INSERT INTO library.collection_member
         (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
       SELECT $1, $2, ('00000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              $3, NULL, 'a' || lpad(n::text, 4, '0'), $4::timestamptz,
              ('00000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
       FROM generate_series(1000, 1499) n`,
      [route, draft.id, id(60), time],
    );
    await client.query('UPDATE library.collection SET member_count = 500 WHERE route = $1 AND collection_id = $2', [
      route,
      draft.id,
    ]);
    const before = await store.listMembers(client, route, draft.id, { after: null, limit: 500 });
    expect(before).toHaveLength(500);

    const rewritten = before.map((row, index) => ({
      memberId: row.id,
      ordinalKey: `a${String(index + 1).padStart(4, '0')}`,
    }));
    let statements = 0;
    const tracked = new Proxy(client, {
      get(target, key) {
        if (key === 'query')
          return (...args: Parameters<pg.PoolClient['query']>) => {
            statements++;
            return target.query(...args);
          };
        return Reflect.get(target, key);
      },
    });
    expect(await store.respaceMembers(tracked, route, draft.id, rewritten, { ...context, transactionId: id(92) })).toBe(
      1,
    );
    expect(statements).toBe(1);

    const after = await store.listMembers(client, route, draft.id, { after: null, limit: 500 });
    expect(after.map(({ id: memberId }) => memberId)).toEqual(before.map(({ id: memberId }) => memberId));
    expect(after.map(({ ordinalKey }) => ordinalKey)).toEqual(rewritten.map(({ ordinalKey }) => ordinalKey));
    expect(await store.readCollection(client, route, draft.id)).toMatchObject({ memberCount: 500, orderEpoch: 1 });
    const distinct = await client.query(
      'SELECT count(DISTINCT ordinal_key)::int AS count FROM library.collection_member WHERE route = $1 AND collection_id = $2',
      [route, draft.id],
    );
    expect(distinct.rows[0]?.count).toBe(500);
  });
});

test('member page, insert and neighbour read have constant row and statement cost at three scales', async () => {
  const growth = await openGrowthDatabase();
  const growthRoute = 0x2345;
  const collectionId = id(900001, growthRoute);
  const curatorId = id(900002, growthRoute);
  const initialMemberId = id(900003, growthRoute);
  const growthContext = { transactionId: id(900004, growthRoute), time };
  try {
    await growth.admin.query(
      `INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, description, visibility, state, revision, member_count,
          order_epoch, created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, 'Growth target', NULL, 'private', 'active', 1, 1, 0, $4, $4, $5)`,
      [growthRoute, collectionId, curatorId, time, growthContext.transactionId],
    );
    await growth.admin.query(
      `INSERT INTO library.collection_member
         (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
       VALUES ($1, $2, $3, $4, NULL, 'a0000', $5, $6)`,
      [growthRoute, collectionId, initialMemberId, id(900005, growthRoute), time, growthContext.transactionId],
    );

    async function seedUnrelated(database: typeof growth, scale: number, previous: number): Promise<void> {
      if (scale === previous) return;
      await database.admin.query(
        `WITH source AS (
           SELECT n,
             ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint + 100000), 8, '0'))::uuid AS collection_id,
             ('30000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint + 200000), 8, '0'))::uuid AS member_id,
             ('40000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint + 300000), 8, '0'))::uuid AS subject_id
           FROM generate_series($2::int + 1, $3::int) AS n
         ), collections AS (
           INSERT INTO library.collection
             (route, collection_id, curator_account_id, title, description, visibility, state, revision, member_count,
              order_epoch, created_at, updated_at, transaction_id)
           SELECT $1, collection_id, $4, 'Unrelated', NULL, 'private', 'active', 1, 1, 0, $5, $5, collection_id
           FROM source
           RETURNING route, collection_id
         )
         INSERT INTO library.collection_member
           (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
         SELECT collections.route, collections.collection_id, source.member_id, source.subject_id, NULL, 'a0000', $5,
                source.member_id
         FROM collections JOIN source USING (collection_id)`,
        [growthRoute, previous, scale, curatorId, time],
      );
      await database.admin.query('ANALYZE library.collection; ANALYZE library.collection_member');
    }

    const report = await checkGrowth(growth, {
      name: 'Collection member access',
      scales: [1000, 8000, 64000],
      repetitions: 5,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: seedUnrelated,
      operation: (database, _scale, repetition) =>
        withConnection(database.pool, async (client) => {
          await client.query('BEGIN');
          try {
            const page = await store.listMembers(client, growthRoute, collectionId, { after: null, limit: 1 });
            const inserted = await store.insertMember(
              client,
              growthRoute,
              collectionId,
              {
                id: id(910000 + repetition, growthRoute),
                subjectId: id(900005, growthRoute),
                note: null,
                ordinalKey: `z${String(repetition).padStart(4, '0')}`,
              },
              { transactionId: id(920000 + repetition, growthRoute), time },
            );
            const neighbours = await store.memberNeighbors(client, growthRoute, collectionId, { kind: 'last' });
            expect(page).toHaveLength(1);
            expect(inserted).not.toBeNull();
            expect(neighbours?.after).toBeNull();
          } finally {
            await client.query('ROLLBACK');
          }
        }),
    });
    expect(report.samples.map(({ cost }) => cost.statements)).toEqual([3, 3, 3]);
    expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
      report.samples[0]!.cost.rows,
      report.samples[0]!.cost.rows,
      report.samples[0]!.cost.rows,
    ]);
  } finally {
    await growth.close();
  }
});
