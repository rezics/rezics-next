import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c66;
const id = (n: number) => `00000000-0000-7000-8000-6c66${n.toString(16).padStart(8, '0')}`;
const deleted = (n: number) => `00000000-0000-4000-8000-0000${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z',
  due = '2026-11-26T12:00:00.000Z';
const pin = {
  provenance: 'profile',
  releaseDigest: 'sha256:' + 'a'.repeat(64),
  acceptingType: 'ex:Game',
  profileId: 'fixture.game',
};
async function code(c: PoolClient, want: string, body: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_archive');
  let found: unknown;
  try {
    await body();
  } catch (e) {
    found = e;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_archive');
  expect(found).toMatchObject({ code: want });
}
test('independent retained entry deletions preserve complete typed snapshots without occupying or cascading from the live slot', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const add = (n: number, deadline = due, revision = 4, storedPin: unknown = pin, state = 'playing') =>
      c.query(
        `INSERT INTO library.entry_deleted(route,account_id,subject_id,requested_subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position,incarnation_id,library_profile_pin,deletion_id,deleted_revision,deleted_at,restore_until) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$7,$7,$9,$9,$10,2,29,$11,$12::jsonb,$13,$6+1,$7,$14)`,
        [
          route,
          id(1),
          id(2),
          id(3),
          state,
          revision,
          at,
          id(4),
          id(5),
          route >> 4,
          id(6),
          storedPin === null ? null : JSON.stringify(storedPin),
          deleted(n),
          deadline,
        ],
      );
    await add(20);
    await add(21);
    const row = (
      await c.query(`SELECT * FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3`, [
        route,
        id(1),
        deleted(20),
      ])
    ).rows[0]!;
    expect(row).toMatchObject({
      route,
      account_id: id(1),
      subject_id: id(2),
      requested_subject_id: id(3),
      state: 'playing',
      revision: 4,
      transaction_id: id(4),
      type_id: id(5),
      type_source_id: id(5),
      type_source_partition: route >> 4,
      type_source_epoch: 2,
      type_source_position: '29',
      incarnation_id: id(6),
      library_profile_pin: pin,
      deletion_id: deleted(20),
      deleted_revision: 5,
      partition_no: route >> 4,
    });
    for (const k of ['created_at', 'updated_at', 'activity_at', 'finished_at', 'deleted_at'])
      expect(row[k].toISOString()).toBe(at);
    expect(row.restore_until.toISOString()).toBe(due);
    await code(c, '23505', () => add(20));
    await code(c, '23514', () => add(22, '2026-11-27T12:00:00.000Z'));
    await code(c, '23514', () => add(23, due, 2147483645));
    await code(c, '23514', () => add(24, due, 4, null, 'playing'));
    await code(c, '23514', () => add(25, due, 4, { ...pin, extra: true }));
    await code(c, '23514', () =>
      c.query(
        `UPDATE library.entry_deleted SET type_source_position=NULL WHERE route=$1 AND account_id=$2 AND deletion_id=$3`,
        [route, id(1), deleted(20)],
      ),
    );
    await code(c, '23502', () =>
      c.query(
        `UPDATE library.entry_deleted SET incarnation_id=NULL WHERE route=$1 AND account_id=$2 AND deletion_id=$3`,
        [route, id(1), deleted(20)],
      ),
    );
    await c.query(
      `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'planned',1,$4,$4,$5)`,
      [route, id(1), id(2), at, id(9)],
    );
    await c.query(`DELETE FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3`, [
      route,
      id(1),
      id(2),
    ]);
    expect(
      (
        await c.query(
          `SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 ORDER BY deletion_id`,
          [route, id(1)],
        )
      ).rows,
    ).toEqual([{ deletion_id: deleted(20) }, { deletion_id: deleted(21) }]);
    const index = (
      await c.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='library' AND tablename='entry_deleted' AND indexname='entry_deleted_due'`,
      )
    ).rows[0]?.indexdef;
    expect(index).toContain('(partition_no, restore_until, route, account_id, deletion_id)');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
