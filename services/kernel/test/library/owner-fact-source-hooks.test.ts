import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const r = 0x6c6d,
  id = (n: number) => '00000000-0000-7000-8000-6c6d' + n.toString(16).padStart(8, '0');
const at = '2026-10-28T00:00:00Z',
  due = '2026-11-27T00:00:00Z';
test('all four native fact drivers and label liveness share one bounded owner source fence without publication or presence side effects', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const fence = async () => {
      const row = (
        await c.query('SELECT generation::text AS n FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
          r,
          id(1),
        ])
      ).rows[0];
      return row ? BigInt(row.n) : 0n;
    };
    await c.query(
      "INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'planned',1,$4,$4,$5)",
      [r, id(1), id(2), at, id(90)],
    );
    expect(await fence()).toBe(1n);
    await c.query("UPDATE library.entry SET state='completed' WHERE route=$1 AND account_id=$2 AND subject_id=$3", [
      r,
      id(1),
      id(2),
    ]);
    expect(await fence()).toBe(2n);
    await c.query('UPDATE library.entry SET updated_at=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      r,
      id(1),
      id(2),
      at,
    ]);
    expect(await fence()).toBe(2n);
    await c.query(
      "INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,'owned',1,$5,$5,$6)",
      [r, id(10), id(1), id(2), at, id(90)],
    );
    expect(await fence()).toBe(3n);
    await c.query("UPDATE library.copy SET note='private note' WHERE route=$1 AND copy_id=$2", [r, id(10)]);
    expect(await fence()).toBe(4n);
    await c.query(
      "INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'scalar_amount','minute',0,'active',1,$5,$6)",
      [r, id(20), id(1), id(2), at, id(90)],
    );
    expect(await fence()).toBe(5n);
    await c.query('UPDATE library.progress_session SET amount=3 WHERE route=$1 AND session_id=$2', [r, id(20)]);
    expect(await fence()).toBe(6n);
    await c.query(
      "INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'Label',1,$4,$4,$5)",
      [r, id(1), id(30), at, id(90)],
    );
    await c.query(
      'INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id,slot_no) VALUES($1,$2,$3,$4,1,$5,$5,$6,0)',
      [r, id(1), id(2), id(30), at, id(90)],
    );
    expect(await fence()).toBe(7n);
    await c.query(
      "UPDATE library.personal_label SET normalized_name='Renamed' WHERE route=$1 AND account_id=$2 AND label_id=$3",
      [r, id(1), id(30)],
    );
    expect(await fence()).toBe(8n);
    await c.query(
      'UPDATE library.personal_label SET deleted_at=$4,purge_after=$5 WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [r, id(1), id(30), at, due],
    );
    expect(await fence()).toBe(9n);
    await c.query(
      'UPDATE library.personal_label SET deleted_at=NULL,purge_after=NULL WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [r, id(1), id(30)],
    );
    expect(await fence()).toBe(10n);
    expect(
      (await c.query('SELECT count(*)::int AS n FROM library.collection WHERE curator_account_id=$1', [id(1)])).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
