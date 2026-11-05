import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c51;
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z',
  due = '2026-11-26T12:00:00.000Z';
async function sqlstate(c: PoolClient, code: string, fn: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_label');
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_label');
  expect(caught).toMatchObject({ code });
}
test('personal labels have owner-scoped identities and bounded soft-deletion keys without exclusive state coupling', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const add = (labelId: string, name: string, account = id(1)) =>
      c.query(
        `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,$5,$5,$6)`,
        [route, account, labelId, name, at, id(90)],
      );
    await add(id(2), 'Wishlist');
    await sqlstate(c, '23505', () => add(id(3), 'Wishlist'));
    await add(id(4), 'wishlist');
    await add(id(2), 'Wishlist', id(5));
    await sqlstate(c, '23514', () => add(id(6), ''));
    await sqlstate(c, '23514', () => add(id(7), 'x'.repeat(101)));
    const assign = (label: string, account = id(1)) =>
      c.query(
        `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,$5,$5,$6)`,
        [route, account, id(8, 0x6c52), label, at, id(91)],
      );
    await assign(id(2));
    await sqlstate(c, '23505', () => assign(id(2)));
    await sqlstate(c, '23503', () => assign(id(4), id(5)));
    await c.query(
      `UPDATE library.personal_label SET deleted_at=$1,purge_after=$2 WHERE route=$3 AND account_id=$4 AND label_id=$5`,
      [at, due, route, id(1), id(2)],
    );
    await add(id(3), 'Wishlist');
    await sqlstate(c, '23505', () =>
      c.query(
        `UPDATE library.personal_label SET deleted_at=NULL,purge_after=NULL WHERE route=$1 AND account_id=$2 AND label_id=$3`,
        [route, id(1), id(2)],
      ),
    );
    await sqlstate(c, '23514', () =>
      c.query(`UPDATE library.label_assignment SET deleted_at=$1 WHERE route=$2 AND account_id=$3 AND label_id=$4`, [
        at,
        route,
        id(1),
        id(2),
      ]),
    );
    await c.query(
      `UPDATE library.label_assignment SET deleted_at=$1,purge_after=$2 WHERE route=$3 AND account_id=$4 AND label_id=$5`,
      [at, due, route, id(1), id(2)],
    );
    const entry = await c.query(`SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3`, [
      route,
      id(1),
      id(8, 0x6c52),
    ]);
    expect(entry.rows).toHaveLength(0);
    await sqlstate(c, '23503', () =>
      c.query(`DELETE FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3`, [
        route,
        id(1),
        id(2),
      ]),
    );
    const indexes = await c.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename,indexdef FROM pg_indexes WHERE schemaname='library' AND tablename IN('personal_label','label_assignment')`,
    );
    for (const table of ['personal_label', 'label_assignment'])
      expect(
        indexes.rows.some(
          (r) =>
            r.tablename === table &&
            r.indexdef.includes('purge_after') &&
            r.indexdef.includes('WHERE (deleted_at IS NOT NULL)'),
        ),
      ).toBe(true);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
