import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/label-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c61;
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-27T12:00:00.000Z';
const ctx = (n: number, at = time) => ({ transactionId: id(n), time: at });
test('private label catalogue normalizes names preserves stable owner-scoped IDs and restores only an unoccupied live name within thirty days', async () => {
  expect(store.normalizePersonalLabelName('  Cafe\u0301\u00a0\t Want  ')).toBe('Café Want');
  expect(store.normalizePersonalLabelName('😀'.repeat(100))).toBe('😀'.repeat(100));
  for (const name of ['', '   ', 'x\0y', '\u0001', '\ud800', '😀'.repeat(101), 7, null])
    expect(() => store.normalizePersonalLabelName(name)).toThrow();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const label = await store.insertPersonalLabel(
      c,
      route,
      { accountId: id(1), id: id(3, 0x6c62), name: '  Want   to read ' },
      ctx(80),
    );
    expect(label.name).toBe('Want to read');
    expect(label.revision).toBe(1);
    expect(label.deletedAt).toBeNull();
    expect(label.purgeAfter).toBeNull();
    expect(await store.readPersonalLabel(c, route, id(1), label.id)).toEqual(label);
    expect(await store.readPersonalLabel(c, route, id(2), label.id)).toBeNull();
    expect(await store.readPersonalLabel(c, route + 1, id(1), label.id)).toBeNull();
    const unchanged = await store.renamePersonalLabel(
      c,
      route,
      id(1),
      label.id,
      1,
      'Want\u00a0to read',
      ctx(81, '2026-10-28T12:00:00.000Z'),
    );
    expect(unchanged).toEqual(label);
    const renamed = await store.renamePersonalLabel(c, route, id(1), label.id, 1, 'want to read', ctx(82));
    expect(renamed?.id).toBe(label.id);
    expect(renamed?.revision).toBe(2);
    expect(renamed?.name).toBe('want to read');
    expect(await store.deletePersonalLabel(c, route, id(1), label.id, 1, ctx(83))).toBeNull();
    await c.query(
      `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,$5,$5,$6)`,
      [route, id(1), id(4), label.id, time, id(84)],
    );
    const deleted = await store.deletePersonalLabel(c, route, id(1), label.id, 2, ctx(85));
    expect(deleted?.revision).toBe(3);
    expect(deleted?.deletedAt).toBe(time);
    expect(deleted?.purgeAfter).toBe('2026-11-26T12:00:00.000Z');
    expect(await store.readPersonalLabel(c, route, id(1), label.id)).toBeNull();
    expect(await store.readPersonalLabel(c, route, id(1), label.id, true)).toEqual(deleted);
    expect(
      (await c.query(`SELECT label_id FROM library.label_assignment WHERE route=$1 AND account_id=$2`, [route, id(1)]))
        .rows,
    ).toEqual([{ label_id: label.id }]);
    const replacement = await store.insertPersonalLabel(
      c,
      route,
      { accountId: id(1), id: id(5), name: 'want to read' },
      ctx(86),
    );
    await c.query('SAVEPOINT name_taken');
    let conflict: unknown;
    try {
      await store.restorePersonalLabel(c, route, id(1), label.id, 3, ctx(87));
    } catch (e) {
      conflict = e;
    }
    await c.query('ROLLBACK TO SAVEPOINT name_taken');
    expect(conflict).toMatchObject({ code: '23505' });
    await store.deletePersonalLabel(c, route, id(1), replacement.id, 1, ctx(88));
    const restored = await store.restorePersonalLabel(
      c,
      route,
      id(1),
      label.id,
      3,
      ctx(89, '2026-11-25T12:00:00.000Z'),
    );
    expect(restored?.id).toBe(label.id);
    expect(restored?.revision).toBe(4);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.name).toBe('want to read');
    expect(
      await store.restorePersonalLabel(c, route, id(1), replacement.id, 2, ctx(90, '2026-11-26T12:00:00.000Z')),
    ).toBeNull();
    const other = await store.insertPersonalLabel(
      c,
      route,
      { accountId: id(2), id: label.id, name: 'want to read' },
      ctx(91),
    );
    expect(other.id).toBe(label.id);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
