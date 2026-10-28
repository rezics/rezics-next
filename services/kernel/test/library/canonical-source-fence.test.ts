import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/collection-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c6b,
  id = (n: number) => '00000000-0000-7000-8000-6c6b' + n.toString(16).padStart(8, '0');
const ctx = { transactionId: id(90), time: '2026-10-28T00:00:00.000Z' };
test('Collection source fence changes atomically with membership authority deletion and restore but not note order or title edits', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ref = id(1),
      owner = id(2),
      subject = id(3);
    const fence = async () =>
      BigInt(
        (
          await c.query(
            'SELECT source_generation::text AS n FROM library.collection WHERE route=$1 AND collection_id=$2',
            [route, ref],
          )
        ).rows[0]!.n,
      );
    const created = await store.insertCollection(
      c,
      route,
      { id: ref, curatorAccountId: owner, title: 'Fence probe', description: null, visibility: 'private' },
      ctx,
    );
    expect(await fence()).toBe(0n);
    expect(created).not.toHaveProperty('sourceGeneration');
    await store.insertMember(c, route, ref, { id: id(10), subjectId: subject, note: 'first', ordinalKey: 'a0' }, ctx);
    expect(await fence()).toBe(1n);
    await store.insertMember(c, route, ref, { id: id(11), subjectId: subject, note: 'second', ordinalKey: 'a1' }, ctx);
    expect(await fence()).toBe(2n);
    expect(await store.deleteMember(c, route, ref, id(99), ctx)).toBeNull();
    expect(await fence()).toBe(2n);
    await store.updateMemberNote(c, route, ref, id(10), 'new note', ctx);
    await store.moveMember(c, route, ref, id(10), 'a2', ctx);
    expect(await fence()).toBe(2n);
    const titled = await store.updateCollection(
      c,
      route,
      ref,
      1,
      { title: 'Renamed', description: 'metadata', visibility: 'private' },
      ctx,
    );
    expect(titled?.revision).toBe(2);
    expect(await fence()).toBe(2n);
    expect(
      await store.updateCollection(c, route, ref, 1, { title: 'stale', description: null, visibility: 'public' }, ctx),
    ).toBeNull();
    expect(await fence()).toBe(2n);
    await store.updateCollection(
      c,
      route,
      ref,
      2,
      { title: 'Renamed', description: 'metadata', visibility: 'public' },
      ctx,
    );
    expect(await fence()).toBe(3n);
    const deleted = await store.tombstoneCollection(c, route, ref, ctx);
    expect(deleted).not.toBeNull();
    expect(await fence()).toBe(4n);
    expect(await store.tombstoneCollection(c, route, ref, ctx)).toBeNull();
    expect(await fence()).toBe(4n);
    const restored = await store.restoreCollection(c, route, ref, deleted!.revision, {
      ...ctx,
      time: '2026-10-29T00:00:00.000Z',
    });
    expect(restored).not.toBeNull();
    expect(await fence()).toBe(5n);
    expect(await store.restoreCollection(c, route, ref, deleted!.revision, ctx)).toBeNull();
    expect(await fence()).toBe(5n);
    expect(await store.deleteMember(c, route, ref, id(10), ctx)).not.toBeNull();
    expect(await fence()).toBe(6n);
    expect(await store.deleteMember(c, route, ref, id(10), ctx)).toBeNull();
    expect(await fence()).toBe(6n);
    expect((await store.readMember(c, route, ref, id(11)))?.note).toBe('second');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
