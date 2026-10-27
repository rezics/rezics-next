import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c68;
const id = (n: number) => '00000000-0000-7000-8000-6c68' + n.toString(16).padStart(8, '0');
const at = '2026-10-27T12:00:00.000Z',
  due = '2026-11-26T12:00:00.000Z';
async function code(c: PoolClient, want: string, body: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_slot');
  let found: unknown;
  try {
    await body();
  } catch (e) {
    found = e;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_slot');
  expect(found).toMatchObject({ code: want });
}
test('one assignment reservation index bounds cap candidates independently of retained history', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (let n = 0; n < 36; n++)
      await c.query(
        'INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,1,$5,$5,$6)',
        [route, id(1), id(100 + n), 'Label ' + n, at, id(90)],
      );
    const add = (n: number, slot: number | null, subject = id(2)) =>
      c.query(
        'INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id,slot_no) VALUES($1,$2,$3,$4,1,$5,$5,$6,$7) RETURNING assignment_id',
        [route, id(1), subject, id(100 + n), at, id(91), slot],
      );
    const identities: string[] = [];
    for (let n = 0; n < 32; n++) identities.push((await add(n, n)).rows[0]!.assignment_id);
    expect(new Set(identities).size).toBe(32);
    for (const value of identities) expect(value).toMatch(/^[0-9a-f-]{36}$/);
    await code(c, '23505', () => add(32, 0));
    await code(c, '23514', () => add(32, 32));
    await add(32, null);
    await add(33, null);
    await code(c, '23514', () =>
      c.query(
        'UPDATE library.label_assignment SET assignment_id=NULL WHERE route=$1 AND account_id=$2 AND label_id=$3',
        [route, id(1), id(100)],
      ),
    );
    await code(c, '23514', () =>
      c.query(
        'UPDATE library.label_assignment SET deleted_at=$1,purge_after=$2 WHERE route=$3 AND account_id=$4 AND label_id=$5',
        [at, due, route, id(1), id(100)],
      ),
    );
    const reserved = (
      await c.query(
        'SELECT assignment_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND slot_no IS NOT NULL ORDER BY assignment_id LIMIT 32',
        [route, id(1), id(2)],
      )
    ).rows;
    expect(reserved).toHaveLength(32);
    expect(new Set(reserved.map((r) => r.assignment_id))).toEqual(new Set(identities));
    expect(
      (
        await c.query(
          'SELECT label_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, id(1), id(2)],
        )
      ).rows,
    ).toHaveLength(34);
    const indexes = (
      await c.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='library' AND tablename='label_assignment' AND indexname='label_assignment_reserved_source'",
      )
    ).rows;
    expect(indexes[0]?.indexdef).toContain('(route, account_id, subject_id, assignment_id)');
    expect(indexes[0]?.indexdef).toContain('WHERE (slot_no IS NOT NULL)');
    await c.query('INSERT INTO library.fact_source_head(route,account_id,generation) VALUES($1,$2,1)', [route, id(1)]);
    await code(c, '23514', () =>
      c.query('UPDATE library.fact_source_head SET generation=0 WHERE route=$1 AND account_id=$2', [route, id(1)]),
    );
    await code(c, '23514', () =>
      c.query('INSERT INTO library.fact_source_head(route,account_id,generation) VALUES($1,$2,1)', [route + 1, id(1)]),
    );
    expect(
      (
        await c.query('SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
          route,
          id(1),
        ])
      ).rows,
    ).toEqual([{ generation: '1' }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
