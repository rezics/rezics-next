import type { Pool } from 'pg';
import { noEffect, registerCommandCallback, runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import {
  IdentityEpochStoreError,
  IDENTITY_EPOCH_CONTROL_PARTITION,
  recordIdentityEpochNativeCommit,
} from './identity-epoch-store.ts';
import { IDENTITY_EPOCH_BOOTSTRAP } from './events.ts';
import type { IdentityNativeReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import subjects from './identity-epoch-bootstrap-subjects.sql';
import members from './identity-epoch-bootstrap-members.sql';
import dirty from './identity-epoch-bootstrap-dirty.sql';
import memberDirty from './identity-epoch-bootstrap-member-dirty.sql';

const NIL = '00000000-0000-0000-0000-000000000000';
type Phase = 'subjects' | 'members' | 'dirty' | 'member-dirty';
type Row = { route: number; original: string; terminal: string; source_revision: string; present: boolean };
type Page = { generation: bigint; phase: Phase; native: IdentityNativeReceipt; rows: Row[] };

/** These are absent OWNER hooks, not registration options. Change capture below does not implement them.
 * Creation must invoke initializeSubject in its native transaction; structural writers must obey the single
 * admitted job and install/reconcile home fences. No caller/test can certify that coverage in this slice.
 */
const missingWriters = Object.freeze([
  'semantic/subject.ts:writeSubject',
  'semantic/account-agents.ts:ensureAccountAgent',
  'semantic/merges.ts:mergeSubjectsInCommand',
  'semantic/merge-moves.ts:register/moveMergePage',
  'semantic/account-agents.ts:unverifyAccountAgent',
]);

export async function readIdentityEpochCutover(tx: CommandTransaction): Promise<
  Readonly<{
    state: 'blocked' | 'ready';
    missingWriters: readonly string[];
  }>
> {
  await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
  // Exhausted snapshots/dirty work are insufficient: currently installed native writers remain uncovered.
  return { state: 'blocked', missingWriters };
}

export type IdentityEpochBootstrapProgress = Readonly<{
  partition: number;
  generation: bigint;
  state: 'more' | 'caught-up';
  native: IdentityNativeReceipt;
  /** rows counts raw source rows; bytes counts their actual serialized retained native payload.
   * points counts producer metadata/result rows touched and statements counts producer statements (including callbacks).
   * These are observations, not a wire-byte/EXPLAIN-block budget or final growth evidence.
   */
  work: NativeStepWork;
}>;

function wake(partition: number, generation: bigint) {
  return { type: IDENTITY_EPOCH_BOOTSTRAP, data: { partition, generation: generation.toString() } };
}
const fail = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Bootstrap source owner missing, moved or not committed');

async function readPage(pool: Pool, partition: number, generation: bigint): Promise<Page | null> {
  return withConnection(pool, async (tx) => {
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active') throw fail();
    const page = (
      await tx.query(
        `SELECT p.*,c.epoch,c.position FROM semantic.identity_epoch_bootstrap_page p
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(p.partition_no,p.transaction_id)
      WHERE p.partition_no=$1 AND p.generation=$2 AND c.purpose='bootstrap' AND p.xmin=c.xmin`,
        [partition, generation.toString()],
      )
    ).rows[0];
    if (!page) return null;
    if (page.epoch !== owner.epoch || BigInt(page.position) > owner.position) throw fail();
    const rows = (
      await tx.query(
        `SELECT route,original::text,terminal::text,source_revision::text,present
      FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=$1 AND transaction_id=$2
      ORDER BY route,original,terminal LIMIT 100`,
        [partition, page.transaction_id],
      )
    ).rows as Row[];
    return {
      generation,
      phase: page.phase,
      native: { partition, epoch: page.epoch, position: BigInt(page.position), transactionId: page.transaction_id },
      rows,
    };
  });
}

/** One indexed <=100-raw-row source page, then released-home control custody.
 * The caller chooses only a native owner partition. Persisted phase/keysets choose all work.
 * Re-delivery first reconciles the next saved page, never skipping an unacknowledged page.
 * caught-up means this owner's queues were observed empty, NEVER catalogue cutover/readiness.
 */
export async function stepIdentityEpochBootstrap(
  pool: Pool,
  partition: number,
): Promise<IdentityEpochBootstrapProgress> {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
    throw new RangeError('Invalid native bootstrap partition');
  const work: NativeStepWork = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  // Accumulate into a mutable local record; public observations remain readonly.
  const measured = { ...work };
  const query = async (tx: CommandTransaction, sql: string, values: unknown[] = []) => {
    measured.statements++;
    const result = await tx.query(sql, values);
    measured.points += result.rowCount ?? 0;
    return result;
  };
  const custody = await withConnection(pool, async (tx) => {
    const owner = await readPartition(tx, IDENTITY_EPOCH_CONTROL_PARTITION);
    measured.statements++;
    if (!owner || owner.writeState !== 'active') throw fail();
    return (
      await query(
        tx,
        `SELECT source_generation FROM semantic.identity_epoch_bootstrap_custody
      WHERE source_partition=$1 ORDER BY source_generation DESC LIMIT 1`,
        [partition],
      )
    ).rows[0];
  });
  const generation = BigInt(custody?.source_generation ?? 0) + 1n;
  let page = await readPage(pool, partition, generation);
  measured.statements += page ? 3 : 2;
  let caughtUp = false;
  if (!page) {
    await runCommand(pool, { partition }, async (tx) => {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_bootstrap_home
        (partition_no,phase,after_route,after_original,after_member) VALUES ($1,'subjects',$2,$3,$3)
        ON CONFLICT DO NOTHING`,
        [partition, partition * 16 - 1, NIL],
      );
      const saved = (
        await query(tx, `SELECT * FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=$1 FOR UPDATE`, [
          partition,
        ])
      ).rows[0]!;
      if (BigInt(saved.generation) >= generation) return noEffect(null);
      if (BigInt(saved.generation) + 1n !== generation) throw fail();
      const phase = saved.phase as Phase;
      const parameters = {
        first_route: partition * 16,
        last_route: partition * 16 + 15,
        after_route: saved.after_route,
        after_original: saved.after_original,
        after_member: saved.after_member,
      };
      measured.statements++;
      const rows: Row[] =
        phase === 'subjects'
          ? await subjects.run(tx, parameters)
          : phase === 'members'
            ? await members.run(tx, parameters)
            : phase === 'dirty'
              ? await dirty.run(tx, parameters)
              : await memberDirty.run(tx, parameters);
      measured.rows = rows.length;
      measured.bytes = Buffer.byteLength(JSON.stringify(rows));
      const last = rows.at(-1);
      const next: Phase =
        rows.length === 100
          ? phase
          : phase === 'subjects'
            ? 'members'
            : phase === 'members'
              ? 'dirty'
              : phase === 'dirty'
                ? 'member-dirty'
                : 'dirty';
      caughtUp =
        phase === 'member-dirty' &&
        rows.length === 0 &&
        !(
          await query(
            tx,
            `SELECT 1 FROM semantic.identity_epoch_dirty WHERE route BETWEEN $1 AND $2
          AND revision>captured_revision LIMIT 1`,
            [partition * 16, partition * 16 + 15],
          )
        ).rowCount;
      const keepCursor = next === phase && last;
      await query(
        tx,
        `UPDATE semantic.identity_epoch_bootstrap_home SET phase=$2,after_route=$3,
        after_original=$4,after_member=$5,generation=$6 WHERE partition_no=$1`,
        [
          partition,
          next,
          keepCursor ? last.route : partition * 16 - 1,
          keepCursor ? (phase === 'members' ? last.terminal : last.original) : NIL,
          keepCursor && phase === 'members' ? last.original : NIL,
          generation.toString(),
        ],
      );
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      // The callback's transaction ID is the actual executor ID, not a UUID chosen as a receipt by this function.
      registerCommandCallback(tx, async (transactionId) => {
        measured.statements++; // native commit callback
        await query(
          tx,
          `INSERT INTO semantic.identity_epoch_bootstrap_page(partition_no,transaction_id,generation,phase)
          VALUES ($1,$2,$3,$4)`,
          [partition, transactionId, generation.toString(), phase],
        );
        await query(
          tx,
          `INSERT INTO semantic.identity_epoch_bootstrap_row
          (partition_no,transaction_id,route,original,terminal,source_revision,present)
          SELECT $1,$2,r.route,r.original,r.terminal,r.source_revision,r.present FROM jsonb_to_recordset($3::jsonb)
          AS r(route integer,original uuid,terminal uuid,source_revision bigint,present boolean)`,
          [partition, transactionId, JSON.stringify(rows)],
        );
        if (phase === 'subjects' || phase === 'dirty') {
          await query(
            tx,
            `UPDATE semantic.identity_epoch_dirty d SET captured_revision=r.source_revision
            FROM jsonb_to_recordset($1::jsonb) AS r(route integer,original uuid,source_revision bigint)
            WHERE (d.route,d.original)=(r.route,r.original) AND d.revision=r.source_revision`,
            [JSON.stringify(rows)],
          );
        } else {
          await query(
            tx,
            `UPDATE semantic.identity_epoch_member_dirty d SET captured_revision=r.source_revision
            FROM jsonb_to_recordset($1::jsonb) AS r(route integer,original uuid,terminal uuid,source_revision bigint)
            WHERE (d.route,d.terminal,d.original)=(r.route,r.terminal,r.original) AND d.revision=r.source_revision`,
            [JSON.stringify(rows)],
          );
        }
      });
      return { value: null, events: [wake(partition, generation)] };
    });
    page = await readPage(pool, partition, generation);
    measured.statements += 3;
    if (!page) throw fail();
  } else {
    measured.rows = page.rows.length;
    measured.bytes = Buffer.byteLength(JSON.stringify(page.rows));
    caughtUp = page.phase === 'member-dirty' && page.rows.length === 0;
  }
  const retained = page;
  // No source connection/transaction survives into this control command. Counts never infer missing ownership.
  await runCommand(pool, { partition: IDENTITY_EPOCH_CONTROL_PARTITION }, async (tx) => {
    const duplicate = (
      await query(
        tx,
        `SELECT native_transaction_id FROM semantic.identity_epoch_bootstrap_custody
      WHERE source_partition=$1 AND source_generation=$2 FOR UPDATE`,
        [partition, generation.toString()],
      )
    ).rows[0];
    if (duplicate) {
      if (duplicate.native_transaction_id !== retained.native.transactionId) throw fail();
      return noEffect(null);
    }
    // Serialize page application for each source owner, including a duplicate racing the preceding read.
    await query(tx, 'SELECT partition_no FROM semantic.identity_epoch_control WHERE partition_no=0 FOR UPDATE');
    const latest = (
      await query(
        tx,
        `SELECT source_generation FROM semantic.identity_epoch_bootstrap_custody
      WHERE source_partition=$1 ORDER BY source_generation DESC LIMIT 1`,
        [partition],
      )
    ).rows[0];
    if (BigInt(latest?.source_generation ?? 0) !== generation - 1n) {
      if (BigInt(latest?.source_generation ?? 0) === generation) return noEffect(null);
      throw fail();
    }
    const data = JSON.stringify(retained.rows);
    if (retained.phase === 'subjects' || retained.phase === 'dirty') {
      await query(
        tx,
        `INSERT INTO semantic.identity_epoch_group(terminal,observed_count)
        SELECT DISTINCT r.terminal,0 FROM jsonb_to_recordset($1::jsonb) AS r(terminal uuid)
        ON CONFLICT DO NOTHING`,
        [data],
      );
      await query(
        tx,
        `WITH input AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(original uuid,terminal uuid,present boolean)
      ), old AS MATERIALIZED (
        SELECT o.* FROM semantic.identity_epoch_original o JOIN input i USING(original) FOR UPDATE OF o
      ), delta AS (
        SELECT terminal,sum(n)::bigint n FROM (
          SELECT terminal,1 n FROM input WHERE present
          UNION ALL SELECT terminal,-1 FROM old WHERE present
        ) d GROUP BY terminal
      ), updated AS (
        INSERT INTO semantic.identity_epoch_original(original,terminal,source_partition,source_generation,present)
        SELECT original,terminal,$2,$3,present FROM input WHERE (SELECT count(*) FROM old)>=0
        ON CONFLICT(original) DO UPDATE SET terminal=excluded.terminal,source_partition=excluded.source_partition,
          source_generation=excluded.source_generation,present=excluded.present
      ) UPDATE semantic.identity_epoch_group g SET observed_count=g.observed_count+delta.n
        FROM delta WHERE g.terminal=delta.terminal AND delta.n<>0`,
        [data, partition, generation.toString()],
      );
    } else {
      await query(
        tx,
        `WITH input AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(original uuid,terminal uuid,present boolean)
      ), removed AS (
        DELETE FROM semantic.identity_epoch_legacy_member m USING input i
        WHERE (m.terminal,m.original)=(i.terminal,i.original) AND NOT i.present
      ) INSERT INTO semantic.identity_epoch_legacy_member(terminal,original,source_partition,source_generation)
        SELECT terminal,original,$2,$3 FROM input WHERE present
        ON CONFLICT(terminal,original) DO UPDATE SET source_partition=excluded.source_partition,source_generation=excluded.source_generation`,
        [data, partition, generation.toString()],
      );
    }
    await query(
      tx,
      `INSERT INTO semantic.identity_epoch_bootstrap_custody
      (source_partition,source_generation,native_transaction_id,native_epoch,native_position)
      VALUES ($1,$2,$3,$4,$5)`,
      [
        partition,
        generation.toString(),
        retained.native.transactionId,
        retained.native.epoch,
        retained.native.position.toString(),
      ],
    );
    return { value: null, events: [wake(partition, generation)] };
  });
  return { partition, generation, state: caughtUp ? 'caught-up' : 'more', native: retained.native, work: measured };
}
