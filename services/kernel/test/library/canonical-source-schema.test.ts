import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const r = 0x6c69,
  id = (n: number) => '00000000-0000-7000-8000-6c69' + n.toString(16).padStart(8, '0');
async function code(c: PoolClient, want: string, body: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_canonical');
  let e: unknown;
  try {
    await body();
  } catch (found) {
    e = found;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_canonical');
  expect(e).toMatchObject({ code: want });
}
test('canonical source generations keep facts immutable and require bounded child cleanup before parent erasure', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO library.collection(route,collection_id,curator_account_id,title,visibility,state,revision,member_count,order_epoch,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'SQL probe','private','active',1,0,0,'2026-10-28T00:00:00Z','2026-10-28T00:00:00Z',$4)",
      [r, id(1), id(2), id(3)],
    );
    expect(
      (
        await c.query('SELECT source_generation::text FROM library.collection WHERE route=$1 AND collection_id=$2', [
          r,
          id(1),
        ])
      ).rows,
    ).toEqual([{ source_generation: '0' }]);
    await c.query('INSERT INTO library.canonical_source_state(route,collection_id) VALUES($1,$2)', [r, id(1)]);
    await code(c, '23514', () =>
      c.query('UPDATE library.canonical_source_state SET ready_generation=$3 WHERE route=$1 AND collection_id=$2', [
        r,
        id(1),
        id(10),
      ]),
    );
    await code(c, '23514', () =>
      c.query("UPDATE library.canonical_source_state SET after_driver='member' WHERE route=$1 AND collection_id=$2", [
        r,
        id(1),
      ]),
    );
    const add = (canonical: string) =>
      c.query(
        "INSERT INTO library.canonical_source_fact(route,collection_id,generation,basis_digest,canonical_subject_id,stored_subject_id,driver,fact_id) VALUES($1,$2,$3,'native-probe',$4,$5,'member',$6)",
        [r, id(1), id(10), canonical, id(20), id(30)],
      );
    await add(id(21));
    await code(c, '23505', () => add(id(22)));
    await code(c, '23503', () =>
      c.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=$2', [r, id(1)]),
    );
    const raw = (
      await c.query(
        'SELECT stored_subject_id,fact_id FROM library.canonical_source_fact WHERE route=$1 AND collection_id=$2',
        [r, id(1)],
      )
    ).rows;
    expect(raw).toEqual([{ stored_subject_id: id(20), fact_id: id(30) }]);
    const index = (
      await c.query(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='library' AND indexname='collection_member_subject'",
      )
    ).rows[0]?.indexdef;
    expect(index).toContain('(route, collection_id, subject_id, member_id)');
    await c.query('DELETE FROM library.canonical_source_fact WHERE route=$1 AND collection_id=$2', [r, id(1)]);
    await c.query('DELETE FROM library.canonical_source_state WHERE route=$1 AND collection_id=$2', [r, id(1)]);
    expect(
      (
        await c.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=$2 RETURNING collection_id', [
          r,
          id(1),
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
