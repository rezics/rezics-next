import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { identityEpochDatabase } from '../semantic/support/identity-epoch.ts';
import { retentionFixture } from './subject-retention-fixture.ts';

const costs = `SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS writes
  FROM pg_stat_xact_user_tables WHERE schemaname='core' AND
    relname IN ('subject_retention_domain','subject_subscription_v1','subject_subscription_key_v1',
      'subject_retention_page_v1','subject_cleanup_v1')`;
async function measured(client: PoolClient, sql: string, args: unknown[], writes: number) {
  await client.query('SELECT pg_stat_force_next_flush()');
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(sql, args);
    const visits = (
      await client.query(`SELECT sum(seq_tup_read+coalesce(idx_tup_fetch,0)) AS visits
      FROM pg_stat_xact_user_tables`)
    ).rows[0]!.visits;
    expect(Number(visits)).toBeLessThanOrEqual(40);
    expect((await client.query(costs)).rows[0]!.writes).toBe(writes);
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

test('original command and privacy evidence survives a lost page worker in two native homes', async () => {
  const db = await identityEpochDatabase();
  let worker: PoolClient | undefined;
  try {
    const { f, resident, book, bootstrap, job, keys } = await retentionFixture(db);
    worker = await db.pool.connect();
    const open = 'SELECT core.open_subject_subscription_v1($1,$2) AS birth';
    const capture = 'SELECT core.capture_subject_retention_page_v1($1,$2,$3) AS cuts';
    const grant = 'SELECT command_through,privacy_through FROM core.advance_subject_cleanup_v1($1)';
    // A permit issued before birth must remain finite.
    expect((await measured(worker, grant, [0], 1))!.command_through).toBe(String(resident.component.position));
    await worker.query('BEGIN');
    await worker.query('SAVEPOINT membership');
    const provisional = (await worker.query(open, [job, bootstrap])).rows[0]!.birth;
    await worker.query('RELEASE SAVEPOINT membership');
    const cleaner = await db.admin.connect();
    try {
      await cleaner.query('BEGIN');
      await cleaner.query("SET LOCAL lock_timeout='100ms'");
      await expect(cleaner.query(grant, [1])).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await cleaner.query('ROLLBACK');
      cleaner.release();
    }
    await expect(worker.query(capture, [provisional, 0, 2])).rejects.toThrow('Missing committed retention membership');
    await worker.query('ROLLBACK');
    const { birth } = (await measured(worker, open, [job, bootstrap], 2 + keys.length))!;
    expect(
      (
        await worker.query(`SELECT input_key FROM core.subject_subscription_key_v1
      WHERE birth<=(SELECT core.subject_membership_revision_v1()) ORDER BY input_key`)
      ).rows.map((row) => row.input_key),
    ).toEqual([...keys]);
    expect((await measured(worker, grant, [1], 0))!.command_through).toBeNull();
    await expect(worker.query(capture, [birth, 1, 2])).rejects.toThrow('Retention page gap');
    const { cuts } = (await measured(worker, capture, [birth, 0, 2], 1))!;
    expect(cuts.map((cut: { home: number }) => cut.home)).toEqual([0, 1]);
    expect(cuts[0].command).toBe(String(resident.component.position));
    expect(cuts[1].command).toBe('0');
    await worker.query('BEGIN');
    await worker.query(capture, [birth, 2, 3]);
    const { pid } = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
    expect((await db.admin.query('SELECT pg_terminate_backend($1,5000) AS stopped', [pid])).rows[0]!.stopped).toBe(
      true,
    );
    worker.release(true);
    worker = undefined;

    // Inspect all retention relations across the ordinary create and withdrawal.
    const usage = async () => {
      await db.pool.query('SELECT pg_stat_force_next_flush()');
      return (
        await db.admin.query(`SELECT relname,seq_scan,idx_scan,n_tup_ins,n_tup_upd,n_tup_del
        FROM pg_stat_user_tables WHERE schemaname='core' AND relname LIKE 'subject_%' ORDER BY relname`)
      ).rows;
    };
    const before = await usage();
    const created = await book(1);
    await f.hide(created.subject.id);
    expect(await usage()).toEqual(before);
    const evidence = async () =>
      (
        await db.admin.query(`SELECT e.position::text,e.epoch,e.event_count,e.event_seq,e.id,e.type,
      e.subject,e.data,e.payload_state,b.transaction_id,l.position::text AS privacy,l.owner_epoch,l.affected,l.impacts
      FROM core.outbox e JOIN editorial.write_basis b USING(partition_no,epoch,position)
      LEFT JOIN semantic.public_filter_privacy_log l ON (l.partition_no,l.transaction_id)=(b.partition_no,b.transaction_id)
      WHERE e.partition_no=1 ORDER BY e.position,e.event_seq`)
      ).rows;
    const original = await evidence();
    expect(
      (await db.admin.query('SELECT count(*)::int AS slots FROM core.outbox WHERE partition_no=1')).rows[0]!.slots,
    ).toBe(original.length);
    const creation = original.filter((row) => row.position === String(created.component.position));
    const visibility = original.filter((row) => row.privacy !== null);
    for (const group of [creation, visibility]) {
      expect(
        group.every(
          (row, i) => row.event_seq === i && row.event_count === group.length && row.payload_state === 'present',
        ),
      ).toBe(true);
    }
    expect([creation.length, visibility.length]).toEqual([2, 2]);
    expect(creation[0]).toMatchObject({ type: 'com.rezics.subject.created.v1', subject: created.subject.id });
    expect(visibility[0]).toMatchObject({
      type: 'com.rezics.subject.visibility_changed.v1',
      subject: created.subject.id,
      data: { id: created.subject.id, visibility: 'hidden' },
      owner_epoch: cuts[1].epoch,
      affected: [{ kind: 'subject', route: 16, subject: created.subject.id }],
      impacts: [{ kind: 'subject', route: 16, subject: created.subject.id }],
    });
    const pending = await db.admin.query(
      `SELECT k.input_key,l.transaction_id
      FROM semantic.public_filter_privacy_pending k JOIN semantic.public_filter_privacy_log l
        ON (l.partition_no,l.owner_epoch,l.position)=(k.partition_no,k.owner_epoch,k.through_position)
      WHERE k.partition_no=1 AND k.live AND k.input_key=$1`,
      ['["scope","subject"]'],
    );
    expect(pending.rows).toEqual([{ input_key: '["scope","subject"]', transaction_id: visibility[0]!.transaction_id }]);
    // Old binaries use these mutations without supplying a version. The
    // database must reject loss of any joined field, including an entire slot.
    const staleMinimize =
      "UPDATE core.outbox SET data='{}',subject=NULL,payload_state='minimized' WHERE partition_no=1";
    for (const sql of [
      staleMinimize,
      'DELETE FROM editorial.write_basis WHERE partition_no=1',
      'DELETE FROM semantic.public_filter_privacy_log WHERE partition_no=1',
    ]) {
      await expect(db.admin.query(sql)).rejects.toThrow('Original Subject subscription evidence retained');
    }
    worker = await db.pool.connect();
    expect((await measured(worker, open, [job, bootstrap], 0))!.birth).toBe(birth);
    expect((await measured(worker, capture, [birth, 0, 2], 0))!.cuts).toEqual(cuts);
    expect((await db.admin.query('SELECT first_home FROM core.subject_retention_page_v1')).rows).toEqual([
      { first_home: 0 },
    ]);
    expect(await measured(worker, grant, [1], 1)).toEqual({
      command_through: cuts[1].command,
      privacy_through: cuts[1].privacy,
    });
    expect(await measured(worker, grant, [1], 0)).toEqual({
      command_through: cuts[1].command,
      privacy_through: cuts[1].privacy,
    });
    await expect(worker.query(staleMinimize)).rejects.toThrow('Original Subject subscription evidence retained');
    expect(await evidence()).toEqual(original);
    expect(
      (
        await worker.query('SELECT visibility FROM semantic.subject WHERE route=0 AND subject_id=$1', [
          resident.subject.id,
        ])
      ).rows[0]!.visibility,
    ).toBe('visible');
    const allowed = "SELECT core.subject_cleanup_allowed_v1(0,1,$1,'command') AS allowed";
    expect((await measured(worker, allowed, [cuts[0].command], 0))!.allowed).toBe(true);
    expect(
      (await measured(
        worker,
        "SELECT core.subject_cleanup_allowed_v1(1,1,$1,'command') AS allowed",
        [String(created.component.position)],
        0,
      ))!.allowed,
    ).toBe(false);
    const cleanup = `UPDATE core.outbox SET data='{}',subject=NULL,payload_state='minimized'
      WHERE (partition_no,position,event_seq)=($1,$2,0) AND core.subject_cleanup_allowed_v1(partition_no,epoch,position,'command')`;
    for (const [home, position, changed] of [
      [0, cuts[0].command, 1],
      [1, String(created.component.position), 0],
    ] as const) {
      await worker.query('SELECT pg_stat_force_next_flush()');
      await worker.query('BEGIN');
      expect((await worker.query(cleanup, [home, position])).rowCount).toBe(changed);
      const cost = await worker.query(`SELECT sum(seq_tup_read+coalesce(idx_tup_fetch,0)) AS visits,
        sum(n_tup_upd) AS updates FROM pg_stat_xact_user_tables`);
      expect(Number(cost.rows[0]!.visits)).toBeLessThanOrEqual(changed ? 24 : 9);
      expect(Number(cost.rows[0]!.updates)).toBe(changed);
      await worker.query('ROLLBACK');
    }
    await worker.query('BEGIN');
    await worker.query("INSERT INTO core.consumer_checkpoint(partition_no,consumer) VALUES(0,'retention_legacy')");
    expect((await worker.query(allowed, [cuts[0].command])).rows[0]!.allowed).toBe(false);
    await worker.query('ROLLBACK');
    await worker.query('BEGIN');
    await expect(worker.query('UPDATE core.partition SET position=position-1 WHERE partition_no=0')).rejects.toThrow(
      'Live copy committed tail cannot move backwards online',
    );
    await worker.query('ROLLBACK');
    await worker.query('BEGIN');
    await worker.query(
      'UPDATE dbos.workflow_writer_fence_domain SET revision=revision+1,restore_generation=gen_random_uuid() WHERE singleton',
    );
    expect((await worker.query(allowed, [cuts[0].command])).rows[0]!.allowed).toBe(false);
    await worker.query('ROLLBACK');
    await worker.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=1");
    expect((await worker.query(allowed, [cuts[0].command])).rows[0]!.allowed).toBe(false);
    await expect(worker.query(grant, [1])).rejects.toThrow();
  } finally {
    worker?.release(true);
    await db.close();
  }
}, 60_000);
