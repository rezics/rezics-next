import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/collection-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c58;
const id = (n: number) => `00000000-0000-7000-8000-6c58${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z';
const tomorrow = '2026-10-28T12:00:00.000Z';
const due = '2026-11-27T12:00:00.000Z';
const ctx = (n: number, time = at) => ({ transactionId: id(n), time });
test('individual Collection tombstones preserve occurrences and restore by revision only within their recorded thirty-day window', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const original = await store.insertCollection(
      c,
      route,
      { id: id(1), curatorAccountId: id(2), title: 'Records', description: 'Keep this', visibility: 'private' },
      ctx(80),
    );
    await store.insertMember(
      c,
      route,
      id(1),
      { id: id(3), subjectId: id(5), note: 'First occurrence', ordinalKey: 'A' },
      ctx(81),
    );
    await store.insertMember(
      c,
      route,
      id(1),
      { id: id(4), subjectId: id(5), note: 'Second occurrence', ordinalKey: 'B' },
      ctx(82),
    );
    const before = await store.listMembers(c, route, id(1), { after: null, limit: 100 });
    expect(before.map((x) => x.id)).toEqual([id(3), id(4)]);
    const deleted = await store.tombstoneCollection(c, route, id(1), ctx(83, tomorrow));
    expect(deleted?.state).toBe('deleted');
    expect(deleted).not.toHaveProperty('deletedAt');
    expect(deleted).not.toHaveProperty('purgeAfter');
    expect(await store.readCollectionDeletion(c, route, id(1))).toEqual({
      revision: deleted!.revision,
      deletedAt: tomorrow,
      purgeAfter: due,
    });
    expect(await store.listMembers(c, route, id(1), { after: null, limit: 100 })).toEqual(before);
    expect(await store.restoreCollection(c, route, id(1), deleted!.revision - 1, ctx(84, tomorrow))).toBeNull();
    expect(await store.restoreCollection(c, route + 1, id(1), deleted!.revision, ctx(84, tomorrow))).toBeNull();
    const restored = await store.restoreCollection(
      c,
      route,
      id(1),
      deleted!.revision,
      ctx(85, '2026-11-26T12:00:00.000Z'),
    );
    expect(restored?.state).toBe('active');
    expect(restored?.revision).toBe(deleted!.revision + 1);
    expect(restored?.title).toBe(original.title);
    expect(restored?.description).toBe(original.description);
    expect(restored?.createdAt).toBe(original.createdAt);
    expect(restored?.orderEpoch).toBe(deleted?.orderEpoch);
    expect(restored?.memberCount).toBe(deleted?.memberCount);
    expect(await store.readCollectionDeletion(c, route, id(1))).toEqual({
      revision: restored!.revision,
      deletedAt: null,
      purgeAfter: null,
    });
    expect(await store.listMembers(c, route, id(1), { after: null, limit: 100 })).toEqual(before);
    expect(await store.restoreCollection(c, route, id(1), deleted!.revision, ctx(86, tomorrow))).toBeNull();
    const again = await store.tombstoneCollection(c, route, id(1), ctx(87, '2026-11-26T12:00:00.000Z'));
    expect(
      await store.restoreCollection(c, route, id(1), again!.revision, ctx(88, '2026-12-26T12:00:00.000Z')),
    ).toBeNull();
    expect(await store.readCollectionDeletion(c, route + 1, id(1))).toBeNull();
    expect(await store.readCollectionDeletion(c, route, id(999))).toBeNull();
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
