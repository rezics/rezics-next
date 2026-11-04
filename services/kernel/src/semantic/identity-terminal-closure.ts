import type { Pool } from 'pg';
import { currentCommand, runCommand, withSingleCommandAttempt, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from './read.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-adapters/index.ts';
import { reserveIdentityTerminalClosure } from './identity-epoch-mapping.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { bindSemanticProducerRoles } from './erasure-producer.ts';
import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import { IDENTITY_EPOCH_BOOTSTRAP } from './events.ts';
import bootstrapHome from './identity-epoch-bootstrap-insert-bootstrap-home.sql';
import deleteEmptySlot from './identity-terminal-closure-delete-empty-slot.sql';

export type TerminalClosureSource = Readonly<{
  route: number;
  original: string;
  terminal: string;
  source_revision: string;
  present: boolean;
  closure_enrollment?: string;
  closure_complete?: boolean;
}>;
type Source = Record<string, any>;
type Directory = Record<string, any>;
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Terminal directory custody unavailable');
const home = (id: string) => {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Terminal closure requires a native original');
  return partitionOf(route);
};
const key = (id: string) => routeOf(id)!;

/** Each command is one executor attempt. A lost result is recovered through the
 * exact native phase fields; an SDK response is never used as custody evidence.
 */
async function native<T>(
  pool: Pool,
  partition: number,
  body: (tx: CommandTransaction) => Promise<T>,
  schedule = false,
) {
  return withSingleCommandAttempt(() =>
    runCommand(pool, { partition }, async (tx) => {
      bindSemanticProducerRoles(tx, []);
      const value = await body(tx);
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      const owner = await readPartition(tx, partition);
      if (!owner || owner.writeState !== 'active') throw unavailable();
      return {
        value,
        events: [
          {
            type: schedule ? IDENTITY_EPOCH_BOOTSTRAP : IDENTITY_EPOCH_PROGRESS,
            data: { partition, generation: (owner.position + 1n).toString() },
          },
        ],
      };
    }),
  );
}

async function source(tx: CommandTransaction, original: string): Promise<Source | null> {
  const row = (
    await tx.query(
      `SELECT m.*,coalesce(d.revision,0)::text AS revision,coalesce(d.captured_revision,0)::text AS captured,
       s.subject_id IS NOT NULL AS present,r.target AS immediate,p.epoch AS actual_epoch,p.write_state
     FROM core.partition p
     LEFT JOIN semantic.subject s ON s.route=$2 AND s.subject_id=$3
     LEFT JOIN semantic.identity_epoch_mapping m ON m.route=$2 AND m.original=$3
     LEFT JOIN semantic.identity_epoch_dirty d ON d.route=$2 AND d.original=$3
     LEFT JOIN LATERAL(SELECT target FROM semantic.redirect WHERE route=$2 AND subject_id=$3 ORDER BY sequence DESC LIMIT 1) r ON true
     WHERE p.partition_no=$1 FOR UPDATE OF p`,
      [home(original), key(original), original],
    )
  ).rows[0];
  if (!row || row.write_state !== 'active') throw unavailable();
  // Lock absence against capture using the same native owner serialization as
  // enrollment. Existing keys additionally serialize on their dirty/mapping rows.
  await tx.query('SELECT 1 FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2 FOR UPDATE', [
    key(original),
    original,
  ]);
  await tx.query('SELECT 1 FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2 FOR UPDATE', [
    key(original),
    original,
  ]);
  return row;
}

async function directory(
  pool: Pool,
  terminal: string,
  original: string,
  enrollment: string,
): Promise<Directory | null> {
  return withReadTransaction(pool, async (tx) => {
    const row = (
      await tx.query(
        `SELECT o.*,g.closure_state AS group_state,g.closure_incarnation AS group_incarnation,
          g.generation AS group_generation,g.published_epoch,g.owner_epoch,
          n.epoch AS registration_epoch,n.position AS registration_position
       FROM semantic.identity_epoch_group g
       JOIN semantic.identity_epoch_original o USING(partition_no,terminal,generation)
       JOIN semantic.identity_epoch_native_commit n ON n.partition_no=o.partition_no
         AND n.transaction_id=o.closure_registration_transaction AND n.xmin::text=o.closure_registration_xid
       JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch
         AND p.position>=n.position AND p.write_state='active' AND p.epoch=g.owner_epoch
       WHERE g.partition_no=$1 AND g.terminal=$2 AND o.original=$3 AND o.closure_enrollment=$4`,
        [home(terminal), terminal, original, enrollment],
      )
    ).rows[0];
    return row ?? null;
  });
}

/** Source-export hold precedes successor discovery, including first enrollment. */
async function exportSource(
  pool: Pool,
  exported: IdentityNativeReceipt,
  row: TerminalClosureSource,
): Promise<Source | null> {
  const result = await native(pool, exported.partition, async (tx) => {
    const retained = (
      await tx.query(
        `SELECT b.closure_enrollment,b.closure_complete,p.generation FROM semantic.identity_epoch_bootstrap_row b
       JOIN semantic.identity_epoch_native_commit n ON n.partition_no=b.partition_no AND n.transaction_id=b.transaction_id
       JOIN semantic.identity_epoch_bootstrap_page p ON p.partition_no=b.partition_no AND p.transaction_id=b.transaction_id
       WHERE b.partition_no=$1 AND b.transaction_id=$2 AND b.original=$3 AND b.route=$4
         AND n.epoch=$5 AND n.position=$6 AND b.source_revision=$7`,
        [
          exported.partition,
          exported.transactionId,
          row.original,
          row.route,
          exported.epoch,
          exported.position.toString(),
          row.source_revision,
        ],
      )
    ).rows[0];
    const recovered = !retained
      ? (
          await tx.query(
            `SELECT closure_enrollment,false AS closure_complete,p.generation
      FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_native_commit n
        ON n.partition_no=m.route/16 AND n.transaction_id=m.closure_hold_transaction AND n.xmin::text=m.closure_hold_xid
      JOIN semantic.identity_epoch_bootstrap_page p ON p.partition_no=m.route/16 AND p.transaction_id=m.closure_export_transaction
      WHERE m.route=$1 AND m.original=$2 AND m.closure_export_transaction=$3 AND m.source_revision=$4
        AND m.closure_state IN ('exporting','installed','active')`,
            [row.route, row.original, exported.transactionId, row.source_revision],
          )
        ).rows[0]
      : retained;
    if (!recovered) throw unavailable();
    const current = await source(tx, row.original);
    if (!current || current.actual_epoch !== exported.epoch) throw unavailable();
    if (
      !current.present ||
      current.revision !== row.source_revision ||
      (current.immediate ?? row.original) !== row.terminal
    ) {
      await tx.query(
        `UPDATE semantic.identity_epoch_bootstrap_row SET closure_complete=true
        WHERE partition_no=$1 AND transaction_id=$2 AND route=$3 AND original=$4`,
        [exported.partition, exported.transactionId, row.route, row.original],
      );
      return null; // Only h is acknowledged by the caller; h+1 remains dirty.
    }
    if (
      current.original &&
      current.closure_state === 'active' &&
      current.source_revision === row.source_revision &&
      current.owner_epoch === exported.epoch &&
      current.closure_immediate === (current.immediate ?? row.original)
    )
      return { ...current, closure_export_generation: recovered.generation };
    if (current.closure_successor_ticket) return null;
    // A cancelled fill still owns its exact outgoing ticket until the native
    // successor has receipted its release. Do not overwrite that recovery key.
    if (current.closure_cancelled_successor) return null;
    if (current.closure_state === 'withdrawn' && current.closure_claim && current.revision === current.source_revision)
      return null;
    if (current.closure_state === 'exporting' || current.closure_state === 'installed') {
      if (current.closure_enrollment !== recovered.closure_enrollment) return null;
      return { ...current, closure_export_generation: recovered.generation };
    }
    const allocation = await reserveIdentityTerminalClosure(tx, exported.transactionId, row.terminal, 1);
    const { transactionId } = currentCommand(tx);
    await tx.query(
      `INSERT INTO semantic.identity_epoch_mapping(route,original,terminal,epoch,origin,recorded_transaction_id,
        owner_epoch,source_revision,closure_state,closure_enrollment,closure_immediate,closure_export_transaction,closure_source_reservation,closure_hold_transaction,closure_hold_xid)
       VALUES($1,$2,$3,0,'published',$4,$5,$6,'exporting',$7,$3,$8,$9,$4,pg_current_xact_id()::xid::text)
       ON CONFLICT(route,original) DO UPDATE SET closure_state='exporting',closure_enrollment=$7,
         closure_immediate=$3,closure_export_transaction=$8,closure_source_reservation=$9,closure_hold_transaction=$4,closure_hold_xid=pg_current_xact_id()::xid::text,source_revision=$6,owner_epoch=$5,
         closure_generation=NULL,closure_incarnation=NULL,closure_registration_transaction=NULL,
         closure_install_transaction=NULL,closure_ack_transaction=NULL,closure_claim=NULL,closure_mutation_xid=NULL,
         control_partition=NULL,control_group=NULL,recorded_transaction_id=$4,origin='published'`,
      [
        row.route,
        row.original,
        row.terminal,
        transactionId,
        exported.epoch,
        row.source_revision,
        recovered.closure_enrollment,
        exported.transactionId,
        allocation,
      ],
    );
    return { ...(await source(tx, row.original)), closure_export_generation: recovered.generation };
  });
  return result.value;
}

/** One serialized successor ticket, stored in the successor's existing native
 * locator. The group lock later decides whether this pending fill can enroll.
 */
async function holdSuccessor(pool: Pool, original: Source): Promise<Source | null> {
  if (original.closure_immediate === original.original) return original;
  return (
    await native(pool, home(original.closure_immediate), async (tx) => {
      const successor = await source(tx, original.closure_immediate);
      if (
        !successor ||
        !successor.present ||
        successor.closure_state !== 'active' ||
        successor.owner_epoch !== successor.actual_epoch ||
        successor.revision !== successor.captured ||
        successor.closure_immediate !== (successor.immediate ?? successor.original) ||
        (successor.closure_successor_ticket && successor.closure_successor_ticket !== original.closure_enrollment)
      )
        return null;
      if (!successor.closure_successor_ticket) {
        const allocation = await reserveIdentityTerminalClosure(
          tx,
          original.closure_export_transaction,
          successor.terminal,
          1,
        );
        await tx.query(
          `UPDATE semantic.identity_epoch_mapping SET closure_successor_ticket=$3,closure_ticket_reservation=$4,closure_successor_original=$5
        WHERE route=$1 AND original=$2`,
          [successor.route, successor.original, original.closure_enrollment, allocation, original.original],
        );
      }
      return successor;
    })
  ).value;
}

async function register(
  pool: Pool,
  exported: IdentityNativeReceipt,
  original: Source,
  successor: Source,
): Promise<Directory | null> {
  const terminal =
    successor.closure_immediate === successor.original && successor.original === original.original
      ? original.original
      : successor.terminal;
  const result = await native(pool, home(terminal), async (tx) => {
    if (original.original === terminal) {
      // Self enrollment shares the source home. A delayed registration cannot
      // revive an export that a native writer already cancelled.
      const current = await source(tx, original.original);
      if (
        !current ||
        !['exporting', 'installed', 'active'].includes(current.closure_state) ||
        current.closure_enrollment !== original.closure_enrollment
      )
        return false;
    }
    const owner = await readPartition(tx, home(terminal));
    if (!owner || owner.writeState !== 'active') throw unavailable();
    await tx.query(
      `INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,owner_epoch)
      VALUES($1,$2,0,$3) ON CONFLICT DO NOTHING`,
      [home(terminal), terminal, owner.epoch],
    );
    const group = (
      await tx.query(
        `SELECT * FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
        [home(terminal), terminal],
      )
    ).rows[0];
    if (!group || group.owner_epoch !== owner.epoch || group.pending_job || group.closure_state !== 'open')
      return false;
    if (
      original.original !== terminal &&
      (group.generation !== successor.closure_generation || group.closure_incarnation !== successor.closure_incarnation)
    )
      return false;
    const existing = (
      await tx.query(
        `SELECT * FROM semantic.identity_epoch_original
      WHERE partition_no=$1 AND generation=$2 AND original=$3 FOR UPDATE`,
        [home(terminal), group.generation, original.original],
      )
    ).rows[0];
    if (existing?.closure_enrollment === original.closure_enrollment) {
      if (
        existing.closure_export_transaction !== exported.transactionId ||
        existing.closure_source_revision !== original.source_revision ||
        existing.closure_source_epoch !== exported.epoch
      )
        throw unavailable();
      return existing.closure_state !== 'withdrawn';
    }
    if (existing && existing.closure_state !== 'legacy' && existing.closure_state !== 'withdrawn') return false;
    if (!existing && BigInt(group.observed_count) >= 4096n) return false;
    const allocation = await reserveIdentityTerminalClosure(tx, exported.transactionId, terminal, 1);
    const { transactionId } = currentCommand(tx);
    await tx.query(
      `INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,
        source_partition,source_generation,present,closure_state,closure_enrollment,closure_incarnation,
        closure_source_revision,closure_source_epoch,closure_export_transaction,closure_registration_transaction,
        closure_registration_xid,closure_reservation)
      VALUES($1,$2,$3,$4,$5,$13,true,'preparing',$6,$7,$8,$9,$10,$11,pg_current_xact_id()::xid::text,$12)
      ON CONFLICT(partition_no,generation,original) DO UPDATE SET
        closure_state='preparing',closure_enrollment=$6,closure_incarnation=$7,closure_source_revision=$8,source_generation=$13,
        closure_source_epoch=$9,closure_export_transaction=$10,closure_registration_transaction=$11,
        closure_registration_xid=pg_current_xact_id()::xid::text,closure_install_transaction=NULL,
        closure_disposition_transaction=NULL,closure_release_transaction=NULL,closure_claim=NULL,closure_reservation=$12,present=true`,
      [
        home(terminal),
        group.generation,
        original.original,
        terminal,
        home(original.original),
        original.closure_enrollment,
        group.closure_incarnation,
        original.source_revision,
        exported.epoch,
        exported.transactionId,
        transactionId,
        allocation,
        original.closure_export_generation,
      ],
    );
    if (original.original === terminal)
      await tx.query(
        `UPDATE semantic.identity_epoch_mapping
      SET terminal=$3,control_partition=$4,control_group=$3,closure_generation=$5,closure_incarnation=$6
      WHERE route=$1 AND original=$2 AND closure_enrollment=$7 AND closure_state='exporting'`,
        [
          original.route,
          original.original,
          terminal,
          home(terminal),
          group.generation,
          group.closure_incarnation,
          original.closure_enrollment,
        ],
      );
    if (!existing)
      await tx.query(
        `UPDATE semantic.identity_epoch_group SET observed_count=observed_count+1,version=version+1
      WHERE partition_no=$1 AND terminal=$2`,
        [home(terminal), terminal],
      );
    return true;
  });
  return result.value ? directory(pool, terminal, original.original, original.closure_enrollment) : null;
}

async function install(pool: Pool, original: Source, entry: Directory): Promise<Source | null> {
  return (
    await native(pool, home(original.original), async (tx) => {
      const current = await source(tx, original.original);
      if (
        !current ||
        current.closure_enrollment !== entry.closure_enrollment ||
        current.closure_export_transaction !== entry.closure_export_transaction ||
        current.closure_state === 'withdrawn' ||
        current.owner_epoch !== entry.closure_source_epoch ||
        current.actual_epoch !== entry.closure_source_epoch ||
        current.revision !== entry.closure_source_revision ||
        current.closure_immediate !== (current.immediate ?? current.original)
      )
        return null;
      if (current.closure_state === 'active' || current.closure_state === 'installed') return current;
      const { transactionId } = currentCommand(tx);
      await tx.query(
        `UPDATE semantic.identity_epoch_mapping SET closure_state='installed',terminal=$3,
      control_partition=$4,control_group=$3,closure_generation=$5,closure_incarnation=$6,
      closure_registration_transaction=$7,closure_install_transaction=$8,closure_install_xid=pg_current_xact_id()::xid::text,
      epoch=$9,recorded_transaction_id=$8 WHERE route=$1 AND original=$2`,
        [
          current.route,
          current.original,
          entry.terminal,
          entry.partition_no,
          entry.generation,
          entry.closure_incarnation,
          entry.closure_registration_transaction,
          transactionId,
          entry.published_epoch,
        ],
      );
      return source(tx, original.original);
    })
  ).value;
}

async function committedInstall(pool: Pool, original: string, enrollment: string): Promise<Source | null> {
  return withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, home(original));
    if (!owner || owner.writeState !== 'active') return null;
    return (
      (
        await tx.query(
          `SELECT m.*,n.epoch AS install_epoch,n.position AS install_position
     FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_native_commit n
       ON n.partition_no=m.route/16 AND n.transaction_id=m.closure_install_transaction AND n.xmin::text=m.closure_install_xid
     JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position AND p.write_state='active'
     WHERE m.route=$1 AND m.original=$2 AND m.closure_enrollment=$3 AND m.closure_state IN ('installed','active')`,
          [key(original), original, enrollment],
        )
      ).rows[0] ?? null
    );
  });
}

async function promote(pool: Pool, installed: Source, entry: Directory): Promise<Directory | null> {
  const result = await native(pool, entry.partition_no, async (tx) => {
    const group = (
      await tx.query(
        `SELECT * FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
        [entry.partition_no, entry.terminal],
      )
    ).rows[0];
    if (
      !group ||
      group.closure_state !== 'open' ||
      group.pending_job ||
      group.generation !== entry.generation ||
      group.closure_incarnation !== entry.closure_incarnation
    )
      return false;
    return (
      (
        await tx.query(
          `UPDATE semantic.identity_epoch_original SET closure_state='installed',closure_install_transaction=$5
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND closure_enrollment=$4
        AND closure_state IN ('preparing','installed') AND closure_registration_transaction=$6
        AND closure_export_transaction=$7 AND closure_source_epoch=$8 AND closure_source_revision=$9 RETURNING original`,
          [
            entry.partition_no,
            entry.generation,
            entry.original,
            entry.closure_enrollment,
            installed.closure_install_transaction,
            installed.closure_registration_transaction,
            installed.closure_export_transaction,
            installed.owner_epoch,
            installed.source_revision,
          ],
        )
      ).rowCount === 1
    );
  });
  return result.value ? directory(pool, entry.terminal, entry.original, entry.closure_enrollment) : null;
}

async function acknowledge(pool: Pool, original: Source, entry: Directory): Promise<boolean> {
  return (
    await native(pool, home(original.original), async (tx) => {
      const current = await source(tx, original.original);
      if (
        !current ||
        current.closure_state === 'withdrawn' ||
        current.closure_enrollment !== entry.closure_enrollment ||
        current.closure_install_transaction !== entry.closure_install_transaction ||
        entry.closure_state !== 'installed' ||
        current.owner_epoch !== current.actual_epoch ||
        current.revision !== entry.closure_source_revision ||
        current.closure_generation !== entry.generation ||
        current.closure_incarnation !== entry.closure_incarnation ||
        current.closure_registration_transaction !== entry.closure_registration_transaction
      )
        return false;
      const { transactionId } = currentCommand(tx);
      await tx.query(
        `UPDATE semantic.identity_epoch_mapping SET closure_state='active',closure_ack_transaction=$3,closure_ack_xid=pg_current_xact_id()::xid::text,closure_source_reservation=NULL
      WHERE route=$1 AND original=$2`,
        [current.route, current.original, transactionId],
      );
      if (current.closure_source_reservation) await releaseCopies(tx, current.closure_source_reservation, 1);
      // ACK exactly h. A later independent dirty head is never consumed here.
      await tx.query(
        `UPDATE semantic.identity_epoch_dirty SET captured_revision=$3
      WHERE route=$1 AND original=$2 AND captured_revision<$3 AND revision=$3`,
        [current.route, current.original, entry.closure_source_revision],
      );
      return true;
    })
  ).value;
}

async function releaseSuccessor(pool: Pool, original: Source): Promise<void> {
  if (original.closure_immediate === original.original) return;
  await native(pool, home(original.closure_immediate), async (tx) => {
    const held = await source(tx, original.closure_immediate);
    const released = await tx.query(
      `UPDATE semantic.identity_epoch_mapping SET closure_successor_ticket=NULL,closure_ticket_reservation=NULL,closure_successor_original=NULL
      WHERE route=$1 AND original=$2 AND closure_successor_ticket=$3 AND closure_successor_original=$4
      RETURNING closure_export_transaction`,
      [key(original.closure_immediate), original.closure_immediate, original.closure_enrollment, original.original],
    );
    if (released.rowCount && held?.closure_ticket_reservation)
      await releaseCopies(tx, held.closure_ticket_reservation, 1);
    return null;
  });
}

async function releaseCopies(tx: CommandTransaction, reservation: string, copies: number) {
  const { partition } = currentCommand(tx);
  const released = await tx.query(
    `UPDATE semantic.identity_epoch_mapping_generation SET closure_copies=closure_copies-$3
    WHERE partition_no=$1 AND generation=$2 AND job_id=$2 AND closure_copies>=$3 RETURNING slot`,
    [partition, reservation, copies],
  );
  if (released.rowCount !== 1) throw unavailable();
  // An empty counter alone is insufficient: each actual retained range must
  // also be empty in this serialized home before releasing its physical slot.
  await tx.query(deleteEmptySlot.sql, [partition, reservation]);
}

/** Bottom-up, at most one successor lookup per source. No recursive alias walk,
 * path cache, hop cutoff or global scan. Pending successors leave native work.
 */
export async function stepIdentityTerminalClosure(
  pool: Pool,
  exported: IdentityNativeReceipt,
  rows: readonly TerminalClosureSource[],
): Promise<boolean> {
  if (rows.length > 100) throw new RangeError('Closure source page exceeds 100');
  for (const row of rows) {
    if (row.closure_complete) continue;
    const original = await exportSource(pool, exported, row);
    if (!original) continue;
    if (original.closure_state === 'active') {
      const current = await directory(pool, original.terminal, original.original, original.closure_enrollment);
      if (
        current?.group_state === 'open' &&
        current.closure_state === 'installed' &&
        current.closure_install_transaction === original.closure_install_transaction
      ) {
        await finalizeDirectory(pool, current);
        await finishSourceRow(pool, exported, row.original, current.closure_enrollment);
      }
      continue;
    }
    if (original.closure_immediate === original.original) await cleanIdentityTerminalClosure(pool, original.original);
    const successor = await holdSuccessor(pool, original);
    if (!successor) continue;
    if (original.original !== successor.original) {
      const bound = await native(pool, home(original.original), async (tx) => {
        const current = await source(tx, original.original);
        if (
          !current ||
          current.closure_enrollment !== original.closure_enrollment ||
          current.closure_state !== 'exporting'
        )
          return false;
        await tx.query(
          `UPDATE semantic.identity_epoch_mapping SET terminal=$3,control_partition=$4,control_group=$3,
          closure_generation=$5,closure_incarnation=$6 WHERE route=$1 AND original=$2`,
          [
            current.route,
            current.original,
            successor.terminal,
            home(successor.terminal),
            successor.closure_generation,
            successor.closure_incarnation,
          ],
        );
        return true;
      });
      if (!bound.value) continue;
    }
    const entry = await register(pool, exported, original, successor);
    if (!entry) continue;
    // Registration has durable native custody before the successor hold is
    // released. A later close includes even this still-preparing directory row.
    await releaseSuccessor(pool, original);
    if (!(await install(pool, original, entry))) continue;
    const installed = await committedInstall(pool, row.original, original.closure_enrollment);
    if (!installed) continue;
    const promoted = await promote(pool, installed, entry);
    if (!promoted || !(await acknowledge(pool, original, promoted))) continue;
    await finalizeDirectory(pool, promoted);
    await finishSourceRow(pool, exported, row.original, promoted.closure_enrollment);
  }
  return withReadTransaction(
    pool,
    async (tx) =>
      !(
        await tx.query(
          `SELECT 1 FROM semantic.identity_epoch_bootstrap_row
    WHERE partition_no=$1 AND transaction_id=$2 AND NOT closure_complete LIMIT 1`,
          [exported.partition, exported.transactionId],
        )
      ).rowCount,
  );
}

async function finishSourceRow(pool: Pool, exported: IdentityNativeReceipt, original: string, enrollment: string) {
  await native(pool, exported.partition, async (tx) => {
    const current = await source(tx, original);
    if (current?.closure_state !== 'active' || current.closure_enrollment !== enrollment) return false;
    await tx.query(
      `UPDATE semantic.identity_epoch_bootstrap_row SET closure_complete=true
      WHERE partition_no=$1 AND transaction_id=$2 AND route=$3 AND original=$4 AND NOT closure_complete`,
      [exported.partition, exported.transactionId, key(original), original],
    );
    return true;
  });
}
async function finalizeDirectory(pool: Pool, entry: Directory) {
  const actual = await withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, home(entry.original));
    if (!owner || owner.writeState !== 'active') return null;
    return (
      await tx.query(
        `SELECT m.* FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_native_commit n
       ON n.partition_no=m.route/16 AND n.transaction_id=m.closure_ack_transaction AND n.xmin::text=m.closure_ack_xid
     WHERE m.route=$1 AND m.original=$2 AND m.closure_enrollment=$3 AND m.closure_state='active'`,
        [key(entry.original), entry.original, entry.closure_enrollment],
      )
    ).rows[0];
  });
  if (!actual || actual.closure_install_transaction !== entry.closure_install_transaction) return;
  await native(pool, entry.partition_no, async (tx) => {
    await tx.query(`SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`, [
      entry.partition_no,
      entry.terminal,
    ]);
    const previous = (
      await tx.query(
        `SELECT closure_reservation FROM semantic.identity_epoch_original
      WHERE partition_no=$1 AND generation=$2 AND original=$3 FOR UPDATE`,
        [entry.partition_no, entry.generation, entry.original],
      )
    ).rows[0];
    const retired = (
      await tx.query(
        `UPDATE semantic.identity_epoch_original SET closure_reservation=NULL
      WHERE partition_no=$1 AND generation=$2 AND original=$3 AND closure_enrollment=$4
        AND closure_reservation IS NOT NULL AND closure_state='installed' RETURNING closure_export_transaction`,
        [entry.partition_no, entry.generation, entry.original, entry.closure_enrollment],
      )
    ).rows[0];
    if (retired && previous?.closure_reservation) await releaseCopies(tx, previous.closure_reservation, 1);
    return null;
  });
}

/** Source page payloads are retired only by their actual source ACK. */
export async function retireIdentityTerminalPage(
  tx: CommandTransaction,
  exported: IdentityNativeReceipt,
  rows: number,
) {
  if (currentCommand(tx).partition !== exported.partition) throw unavailable();
  if (!Number.isInteger(rows) || rows < 0 || rows > 100) throw new RangeError('Invalid retained page size');
  const released = (
    await tx.query(
      `WITH locked AS (
    SELECT p.closure_page_reservation FROM semantic.identity_epoch_bootstrap_page p
    WHERE p.partition_no=$1 AND p.transaction_id=$2 AND p.acknowledged
      AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row r
        WHERE r.partition_no=$1 AND r.transaction_id=$2) FOR UPDATE OF p
  ) UPDATE semantic.identity_epoch_bootstrap_page p SET closure_page_reservation=NULL FROM locked
    WHERE p.partition_no=$1 AND p.transaction_id=$2 RETURNING locked.closure_page_reservation`,
      [exported.partition, exported.transactionId],
    )
  ).rows[0];
  if (!released) throw unavailable();
  if (released.closure_page_reservation) await releaseCopies(tx, released.closure_page_reservation, rows);
}

type DrainClaim = Readonly<{
  terminal: string;
  generation: string;
  incarnation: string;
  claim: string;
  native: IdentityNativeReceipt;
}>;
const drainedClaims = new WeakSet<object>();

/** Close and keyset-drain one actual terminal directory. Preparing fills are
 * included. A source transaction is always released before directory ACK.
 */
export async function drainIdentityTerminalClosure(
  pool: Pool,
  terminal: string,
  claim: string,
): Promise<DrainClaim | null> {
  const closed = await native(
    pool,
    home(terminal),
    async (tx) => {
      const group = (
        await tx.query(
          `SELECT * FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
          [home(terminal), terminal],
        )
      ).rows[0];
      if (!group || group.pending_job || (group.closure_claim && group.closure_claim !== claim)) return null;
      if (group.closure_state === 'open') {
        await reserveIdentityTerminalClosure(tx, claim, terminal, Number(group.observed_count), false);
        await tx.query(
          `UPDATE semantic.identity_epoch_group
      SET closure_state='closing',closure_claim=$3,closure_after=NULL,closure_close_transaction=$4,ready=false,version=version+1
      WHERE partition_no=$1 AND terminal=$2`,
          [home(terminal), terminal, claim, currentCommand(tx).transactionId],
        );
        await tx.query(bootstrapHome.sql, [
          home(terminal),
          home(terminal) * 16 - 1,
          '00000000-0000-0000-0000-000000000000',
        ]);
        await tx.query(
          `UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
        sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=$1`,
          [home(terminal)],
        );
      }
      return group;
    },
    true,
  );
  if (!closed.value) return null;
  const group = closed.value;
  const page = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT o.* FROM semantic.identity_epoch_original o JOIN semantic.identity_epoch_group g USING(partition_no,terminal,generation)
     WHERE g.partition_no=$1 AND g.terminal=$2 AND g.closure_claim=$3 AND g.closure_state IN ('closing','drained')
       AND (g.closure_after IS NULL OR o.original>g.closure_after)
     ORDER BY o.original LIMIT 100`,
          [home(terminal), terminal, claim],
        )
      ).rows,
  );
  for (const member of page) {
    const withdrawn = await native(pool, member.source_partition, async (tx) => {
      const current = await source(tx, member.original);
      if (!current) throw unavailable();
      // A legacy directory row cannot certify an installed closure. Its native
      // mapping must still be withdrawn; absence is acknowledged at this home.
      const exact = member.closure_enrollment && current.closure_enrollment === member.closure_enrollment;
      const legacy =
        !member.closure_enrollment &&
        current.control_group === terminal &&
        (current.closure_state === 'legacy' ||
          (current.closure_state === 'withdrawn' && current.closure_claim === claim));
      if (current.original && (exact || legacy)) {
        if (
          current.owner_epoch !== current.actual_epoch ||
          (member.closure_source_epoch !== null &&
            member.closure_source_epoch !== undefined &&
            current.owner_epoch !== member.closure_source_epoch)
        )
          throw unavailable();
        const { transactionId } = currentCommand(tx);
        const revision =
          current.closure_state === 'withdrawn' && current.closure_claim === claim
            ? current.source_revision
            : (
                await tx.query(
                  `INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES($1,$2)
            ON CONFLICT(route,original) DO UPDATE SET revision=identity_epoch_dirty.revision+1 RETURNING revision`,
                  [key(member.original), member.original],
                )
              ).rows[0]!.revision;
        await tx.query(
          `UPDATE semantic.identity_epoch_mapping SET source_revision=$5,closure_state='withdrawn' ,closure_claim=$3,
          closure_successor_ticket=NULL,closure_successor_original=NULL,closure_ticket_reservation=NULL,closure_source_reservation=NULL,closure_withdraw_transaction=$4,closure_withdraw_xid=pg_current_xact_id()::xid::text,
          closure_generation=$6,closure_incarnation=$7,closure_immediate=coalesce(closure_immediate,$8::uuid),
          closure_cancelled_successor=closure_enrollment IS NOT NULL AND coalesce(closure_immediate,$8::uuid)<>original,
          closure_mutation_xid=NULL WHERE route=$1 AND original=$2`,
          [
            key(member.original),
            member.original,
            claim,
            transactionId,
            revision,
            group.generation,
            group.closure_incarnation,
            current.immediate ?? member.original,
          ],
        );
        if (current.closure_source_reservation) await releaseCopies(tx, current.closure_source_reservation, 1);
        if (current.closure_ticket_reservation) await releaseCopies(tx, current.closure_ticket_reservation, 1);
        await tx.query(
          `UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
          sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=$1`,
          [member.source_partition],
        );
      } else if (current.original && current.control_group === terminal && current.closure_state !== 'withdrawn') {
        // An unclassified installed route is not a guessed removal receipt.
        throw unavailable();
      }
      return null;
    });
    await native(pool, home(terminal), async (tx) => {
      const actual = (
        await tx.query(
          `SELECT * FROM semantic.identity_epoch_group
        WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
          [home(terminal), terminal],
        )
      ).rows[0];
      if (
        !actual ||
        actual.generation !== group.generation ||
        actual.closure_incarnation !== group.closure_incarnation ||
        actual.closure_claim !== claim ||
        actual.closure_state !== 'closing'
      )
        return false;
      // Accept the precise committed source component, never a response count.
      const oldReservation = (
        await tx.query(
          `SELECT closure_reservation FROM semantic.identity_epoch_original
        WHERE partition_no=$1 AND generation=$2 AND original=$3 FOR UPDATE`,
          [home(terminal), group.generation, member.original],
        )
      ).rows[0]?.closure_reservation;
      await tx.query(
        `UPDATE semantic.identity_epoch_original SET closure_state='withdrawn',closure_claim=$5,closure_reservation=$5,
        closure_disposition_transaction=$6,closure_disposition_epoch=$7,closure_disposition_position=$8
        WHERE partition_no=$1 AND generation=$2 AND original=$3 AND closure_enrollment IS NOT DISTINCT FROM $4::uuid`,
        [
          home(terminal),
          group.generation,
          member.original,
          member.closure_enrollment,
          claim,
          withdrawn.transactionId,
          withdrawn.epoch,
          withdrawn.position.toString(),
        ],
      );
      if (oldReservation && oldReservation !== claim) await releaseCopies(tx, oldReservation, 1);
      // A contiguous frontier is advanced only over this very first remaining
      // key, including withdrawn/preparing members from an interrupted page.
      const first = (
        await tx.query(
          `SELECT original FROM semantic.identity_epoch_original
        WHERE partition_no=$1 AND terminal=$2 AND generation=$3
          AND ($4::uuid IS NULL OR original>$4) ORDER BY original LIMIT 1`,
          [home(terminal), terminal, group.generation, actual.closure_after],
        )
      ).rows[0];
      if (first?.original !== member.original) return false;
      await tx.query(
        `UPDATE semantic.identity_epoch_group SET closure_after=$3 WHERE partition_no=$1 AND terminal=$2`,
        [home(terminal), terminal, member.original],
      );
      return true;
    });
  }
  const sealed = await native(pool, home(terminal), async (tx) => {
    const actual = (
      await tx.query(
        `SELECT * FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
        [home(terminal), terminal],
      )
    ).rows[0];
    if (
      !actual ||
      actual.generation !== group.generation ||
      actual.closure_incarnation !== group.closure_incarnation ||
      actual.closure_claim !== claim
    )
      return false;
    if (
      (
        await tx.query(
          `SELECT 1 FROM semantic.identity_epoch_original WHERE partition_no=$1 AND terminal=$2
      AND generation=$3 AND ($4::uuid IS NULL OR original>$4) LIMIT 1`,
          [home(terminal), terminal, group.generation, actual.closure_after],
        )
      ).rowCount
    )
      return false;
    const { transactionId } = currentCommand(tx);
    await tx.query(
      `UPDATE semantic.identity_epoch_group SET closure_state='drained',closure_seal_transaction=$3
      WHERE partition_no=$1 AND terminal=$2`,
      [home(terminal), terminal, transactionId],
    );
    return true;
  });
  if (!sealed.value) return null;
  const result: DrainClaim = {
    terminal,
    generation: group.generation,
    incarnation: group.closure_incarnation,
    claim,
    native: {
      partition: sealed.partition,
      transactionId: sealed.transactionId,
      epoch: sealed.epoch,
      position: sealed.position,
    },
  };
  drainedClaims.add(result);
  return result;
}

const mutationBindings = new WeakMap<CommandTransaction, Set<string>>();

/** Install the native permission only in the live source command. Its exact
 * directory seal was produced by the private drain, and its source withdrawal
 * serializes on this same mapping row before the affecting source write.
 */
export async function bindIdentityTerminalMutation(
  tx: CommandTransaction,
  original: string,
  drained: DrainClaim,
): Promise<void> {
  const command = currentCommand(tx);
  if (!drainedClaims.has(drained) || command.partition !== home(original)) throw unavailable();
  const current = await source(tx, original);
  if (
    current &&
    ['exporting', 'installed'].includes(current.closure_state) &&
    current.control_group === drained.terminal &&
    current.closure_generation === drained.generation &&
    current.closure_incarnation === drained.incarnation &&
    current.owner_epoch === current.actual_epoch &&
    current.revision === current.source_revision
  ) {
    // Enrollment can lose the group lock before its directory insertion. The
    // group is now natively sealed, so its late registration is fenced. This
    // still-nonpositive source hold can be cancelled in the actual writer TX.
    await cancelUnpublished(tx, current, drained.claim);
    return;
  }
  if (
    !current ||
    current.closure_state !== 'withdrawn' ||
    current.closure_claim !== drained.claim ||
    current.control_group !== drained.terminal ||
    current.closure_generation !== drained.generation ||
    current.closure_incarnation !== drained.incarnation ||
    current.owner_epoch !== current.actual_epoch ||
    current.revision !== current.source_revision
  )
    throw unavailable();
  const proof = (
    await tx.query(
      `SELECT 1 FROM semantic.identity_epoch_native_commit n
    WHERE n.partition_no=$1 AND n.transaction_id=$2 AND n.xmin::text=$3`,
      [command.partition, current.closure_withdraw_transaction, current.closure_withdraw_xid],
    )
  ).rowCount;
  if (proof !== 1) throw unavailable();
  await tx.query(
    `UPDATE semantic.identity_epoch_mapping SET closure_mutation_xid=pg_current_xact_id()::text
    WHERE route=$1 AND original=$2`,
    [key(original), original],
  );
  const bound = mutationBindings.get(tx) ?? new Set<string>();
  bound.add(original);
  mutationBindings.set(tx, bound);
}

async function cancelUnpublished(tx: CommandTransaction, current: Source, claim: string | null) {
  const command = currentCommand(tx);
  // An ordinary producer does not otherwise emit a bootstrap native receipt.
  // Recovery must prove this cancellation's committed source transaction too.
  recordIdentityEpochNativeCommit(tx, 'bootstrap');
  await tx.query(
    `UPDATE semantic.identity_epoch_mapping SET closure_state='withdrawn',closure_claim=$3,
    closure_source_reservation=NULL,closure_mutation_xid=pg_current_xact_id()::text,
    closure_cancelled_successor=closure_immediate IS NOT NULL AND closure_immediate<>original,
    closure_withdraw_transaction=$4,closure_withdraw_xid=pg_current_xact_id()::xid::text
    WHERE route=$1 AND original=$2`,
    [current.route, current.original, claim, command.transactionId],
  );
  if (current.closure_source_reservation) await releaseCopies(tx, current.closure_source_reservation, 1);
  await tx.query(
    `UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,
    sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=$1`,
    [command.partition],
  );
}

/** An export with no chosen directory has never been positive. Cancellation
 * locks its actual source; a concurrent target bind must observe this fence.
 * Its successor ticket, if any, is retired from its original pointer below.
 */
export async function cancelUnregisteredIdentityTerminalCapture(
  tx: CommandTransaction,
  original: string,
): Promise<boolean> {
  const current = await source(tx, original);
  if (!current || current.closure_state !== 'exporting' || current.control_group || current.closure_successor_ticket)
    return false;
  await cancelUnpublished(tx, current, null);
  return true;
}

async function recoverSuccessorTickets(pool: Pool, partition: number) {
  const tickets = await recoveryPage(pool, partition, 'incoming');
  for (const ticket of tickets) {
    if (!ticket.parent) throw unavailable();
    const resolved = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, home(ticket.parent));
      if (!owner || owner.writeState !== 'active') return false;
      const current = (
        await tx.query(
          `SELECT closure_state,closure_enrollment,owner_epoch
        FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2`,
          [key(ticket.parent), ticket.parent],
        )
      ).rows[0];
      // Source enrollment is never reused. A different enrollment is an actual
      // native retirement fence, not absence of a workflow response.
      return (
        current &&
        current.owner_epoch === owner.epoch &&
        (current.closure_enrollment !== ticket.enrollment || current.closure_state === 'withdrawn')
      );
    });
    if (!resolved) continue;
    await native(pool, partition, async (tx) => {
      const current = await source(tx, ticket.original);
      if (!current || current.closure_successor_ticket !== ticket.enrollment) return false;
      await tx.query(
        `UPDATE semantic.identity_epoch_mapping SET closure_successor_ticket=NULL,
        closure_successor_original=NULL,closure_ticket_reservation=NULL WHERE route=$1 AND original=$2`,
        [key(ticket.original), ticket.original],
      );
      if (current.closure_ticket_reservation) await releaseCopies(tx, current.closure_ticket_reservation, 1);
      return true;
    });
  }
}

/** These cursors enumerate existing native locator rows, never ancestors. An
 * unresolved ticket cannot hide a later cancelled ticket on the same home.
 * The home is already installed before it can own any closure enrollment.
 */
async function recoveryPage(pool: Pool, partition: number, kind: 'incoming' | 'cancelled'): Promise<Source[]> {
  const incoming = kind === 'incoming';
  const predicate = incoming ? 'closure_successor_ticket IS NOT NULL' : 'closure_cancelled_successor';
  const pending = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT 1
    FROM semantic.identity_epoch_mapping WHERE route BETWEEN $1*16 AND $1*16+15 AND ${predicate} LIMIT 1`,
          [partition],
        )
      ).rowCount,
  );
  if (!pending) return [];
  // Both column pairs and the predicate are a closed private choice above.
  const routeColumn = incoming ? 'closure_ticket_after_route' : 'closure_cancel_after_route';
  const originalColumn = incoming ? 'closure_ticket_after_original' : 'closure_cancel_after_original';
  return (
    await native(pool, partition, async (tx) => {
      const cursor = (
        await tx.query(
          `SELECT ${routeColumn} AS route,${originalColumn} AS original
      FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=$1 FOR UPDATE`,
          [partition],
        )
      ).rows[0];
      if (!cursor) throw unavailable();
      const rows = (
        await tx.query(
          `SELECT *,closure_successor_original AS parent,closure_successor_ticket AS enrollment
      FROM semantic.identity_epoch_mapping WHERE route BETWEEN $1*16 AND $1*16+15
        AND ${predicate} AND (route,original)>($2::integer,$3::uuid) ORDER BY route,original LIMIT 100`,
          [partition, cursor.route, cursor.original],
        )
      ).rows;
      const last = rows.length === 100 ? rows.at(-1) : null;
      await tx.query(
        `UPDATE semantic.identity_epoch_bootstrap_home SET ${routeColumn}=$2,${originalColumn}=$3
      WHERE partition_no=$1`,
        [partition, last?.route ?? partition * 16 - 1, last?.original ?? '00000000-0000-0000-0000-000000000000'],
      );
      return rows;
    })
  ).value;
}

/** Cancellation keeps the outgoing enrollment in the original native locator.
 * Its own dirty home releases the successor even if that successor has no work
 * scheduled. A lost response repeats the exact release; a later enrollment is
 * forbidden until this source commits the resolved disposition.
 */
async function recoverCancelledSuccessors(pool: Pool, partition: number): Promise<void> {
  for (const candidate of await recoveryPage(pool, partition, 'cancelled')) {
    const current = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, partition);
      if (!owner || owner.writeState !== 'active') throw unavailable();
      return (
        await tx.query(
          `SELECT m.* FROM semantic.identity_epoch_mapping m
        JOIN semantic.identity_epoch_native_commit n ON n.partition_no=m.route/16
          AND n.transaction_id=m.closure_withdraw_transaction AND n.xmin::text=m.closure_withdraw_xid
        WHERE m.route=$1 AND m.original=$2 AND m.closure_enrollment=$3 AND m.closure_cancelled_successor
          AND m.closure_state='withdrawn' AND m.owner_epoch=$4 AND n.epoch=$4`,
          [candidate.route, candidate.original, candidate.closure_enrollment, owner.epoch],
        )
      ).rows[0];
    });
    if (!current) continue;
    await releaseSuccessor(pool, current);
    await native(pool, partition, async (tx) => {
      const actual = await source(tx, current.original);
      if (
        !actual ||
        !actual.closure_cancelled_successor ||
        actual.closure_state !== 'withdrawn' ||
        actual.closure_enrollment !== current.closure_enrollment
      )
        return false;
      await tx.query(
        `UPDATE semantic.identity_epoch_mapping SET closure_cancelled_successor=false
        WHERE route=$1 AND original=$2 AND closure_enrollment=$3`,
        [current.route, current.original, current.closure_enrollment],
      );
      return true;
    });
  }
}

/** Additive publication interlock. Rating and fixed participant checks retain
 * their own independent authority; this supplies no rating-effect permission.
 */
export async function assertIdentityTerminalGroupsOpen(
  tx: CommandTransaction,
  terminals: readonly string[],
): Promise<void> {
  const { partition } = currentCommand(tx);
  if (terminals.length > 100) throw new RangeError('Closure control page exceeds 100');
  if (
    (
      await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=ANY($2::uuid[])
    AND closure_state<>'open' LIMIT 1 FOR UPDATE`,
        [partition, terminals],
      )
    ).rowCount
  )
    throw unavailable();
}

/** Delete only receipted withdrawn members, one native keyset page. A new
 * incarnation is opened only after the actual old directory range is empty.
 */
export async function cleanIdentityTerminalClosure(pool: Pool, terminal: string): Promise<boolean> {
  return (
    await native(pool, home(terminal), async (tx) => {
      const group = (
        await tx.query(
          `SELECT * FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`,
          [home(terminal), terminal],
        )
      ).rows[0];
      if (!group || group.closure_state !== 'drained') return false;
      const removed = (
        await tx.query(
          `DELETE FROM semantic.identity_epoch_original o USING
      (SELECT original FROM semantic.identity_epoch_original WHERE partition_no=$1 AND terminal=$2 AND generation=$3
         AND closure_state='withdrawn' AND closure_claim=$4 AND closure_disposition_transaction IS NOT NULL AND closure_release_transaction IS NOT NULL
       ORDER BY original LIMIT 100) page
      WHERE o.partition_no=$1 AND o.terminal=$2 AND o.generation=$3 AND o.original=page.original
      RETURNING o.closure_reservation`,
          [home(terminal), terminal, group.generation, group.closure_claim],
        )
      ).rows;
      for (const reservation of new Set(removed.map((r) => r.closure_reservation).filter(Boolean))) {
        await releaseCopies(tx, reservation, removed.filter((r) => r.closure_reservation === reservation).length);
      }
      if (
        (
          await tx.query(
            `SELECT 1 FROM semantic.identity_epoch_original
      WHERE partition_no=$1 AND terminal=$2 AND generation=$3 LIMIT 1`,
            [home(terminal), terminal, group.generation],
          )
        ).rowCount
      )
        return false;
      if (
        (
          await tx.query(`SELECT 1 FROM semantic.redirect WHERE route=$1 AND subject_id=$2 LIMIT 1`, [
            key(terminal),
            terminal,
          ])
        ).rowCount
      ) {
        await tx.query(
          `UPDATE semantic.identity_epoch_group SET closure_cleanup_complete=true,closure_claim=NULL
        WHERE partition_no=$1 AND terminal=$2`,
          [home(terminal), terminal],
        );
        if (group.closure_claim) await releaseCopies(tx, group.closure_claim, 0);
        return true;
      }
      await tx.query(
        `UPDATE semantic.identity_epoch_group SET generation=gen_random_uuid(),closure_incarnation=gen_random_uuid(),
      closure_state='open',closure_claim=NULL,closure_after=NULL,closure_close_transaction=NULL,closure_seal_transaction=NULL,closure_cleanup_complete=false,
      observed_count=0,ready=false,version=version+1 WHERE partition_no=$1 AND terminal=$2`,
        [home(terminal), terminal],
      );
      if (group.closure_claim) await releaseCopies(tx, group.closure_claim, 0);
      return true;
    })
  ).value;
}

/** A completed/failed exclusive source attempt gives back the old claims through
 * native source commits. This also fences any delayed attempt holding an older
 * in-memory drain object. It does not retire foreign Search/Library custody.
 */
export async function releaseIdentityTerminalClaim(pool: Pool, drained: DrainClaim): Promise<boolean> {
  const members = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT o.* FROM semantic.identity_epoch_original o JOIN semantic.identity_epoch_group g USING(partition_no,terminal,generation)
     WHERE g.partition_no=$1 AND g.terminal=$2 AND g.closure_state='drained' AND g.closure_claim=$3
       AND o.closure_state='withdrawn' AND o.closure_release_transaction IS NULL ORDER BY o.original LIMIT 100`,
          [home(drained.terminal), drained.terminal, drained.claim],
        )
      ).rows,
  );
  for (const member of members) {
    const released = await native(pool, member.source_partition, async (tx) => {
      const current = await source(tx, member.original);
      if (current?.closure_claim === drained.claim && current.closure_state === 'withdrawn') {
        await tx.query(
          `UPDATE semantic.identity_epoch_mapping SET closure_claim=NULL,closure_mutation_xid=NULL
          WHERE route=$1 AND original=$2 AND closure_claim=$3 AND closure_state='withdrawn'`,
          [key(member.original), member.original, drained.claim],
        );
      }
      return null;
    });
    await native(pool, home(drained.terminal), async (tx) => {
      await tx.query(`SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 FOR UPDATE`, [
        home(drained.terminal),
        drained.terminal,
      ]);
      await tx.query(
        `UPDATE semantic.identity_epoch_original SET closure_release_transaction=$5
        WHERE partition_no=$1 AND generation=$2 AND original=$3 AND closure_claim=$4 AND closure_state='withdrawn'
          AND closure_release_transaction IS NULL`,
        [home(drained.terminal), drained.generation, member.original, drained.claim, released.transactionId],
      );
      return null;
    });
  }
  return members.length < 100;
}

/** Native maintenance recovers the same retained seal, including a source
 * attempt whose response was lost. Only one indexed local group is selected.
 */
export async function recoverIdentityTerminalClosure(pool: Pool, partition: number): Promise<void> {
  await recoverCancelledSuccessors(pool, partition);
  await recoverSuccessorTickets(pool, partition);
  const row = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT g.*,n.epoch AS native_epoch,n.position AS native_position FROM semantic.identity_epoch_group g
     JOIN semantic.identity_epoch_native_commit n ON n.partition_no=g.partition_no
       AND n.transaction_id=coalesce(g.closure_seal_transaction,g.closure_close_transaction)
     JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=n.epoch AND p.position>=n.position AND p.write_state='active'
     WHERE g.partition_no=$1 AND g.closure_state IN ('closing','drained') AND NOT g.closure_cleanup_complete ORDER BY g.terminal LIMIT 1`,
          [partition],
        )
      ).rows[0],
  );
  if (!row) return;
  if (row.closure_state === 'closing') {
    await drainIdentityTerminalClosure(pool, row.terminal, row.closure_claim);
    return;
  }
  const drained: DrainClaim = {
    terminal: row.terminal,
    generation: row.generation,
    incarnation: row.closure_incarnation,
    claim: row.closure_claim,
    native: {
      partition,
      transactionId: row.closure_seal_transaction,
      epoch: row.native_epoch,
      position: BigInt(row.native_position),
    },
  };
  await releaseIdentityTerminalClaim(pool, drained);
  await cleanIdentityTerminalClosure(pool, drained.terminal);
}

/** The scan frontier is independent of unresolved directory fills. Keeping a
 * page open until its aliases resolve would hide a terminal on a later page.
 * Each source header owns its captured head and exact enrollment after transport
 * ACK, and this bounded keyset revisits those headers without a path vector.
 */
export async function advanceIdentityTerminalClosures(pool: Pool, partition: number): Promise<void> {
  const pending = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT 1
    FROM semantic.identity_epoch_mapping WHERE route BETWEEN $1*16 AND $1*16+15
      AND closure_state IN ('exporting','installed') LIMIT 1`,
          [partition],
        )
      ).rowCount,
  );
  if (!pending) return;
  const selected = await native(pool, partition, async (tx) => {
    const cursor = (
      await tx.query(
        `SELECT closure_after_route,closure_after_original
      FROM semantic.identity_epoch_bootstrap_home WHERE partition_no=$1 FOR UPDATE`,
        [partition],
      )
    ).rows[0];
    if (!cursor) return [];
    const rows = (
      await tx.query(
        `SELECT m.route,m.original,m.closure_immediate AS terminal,m.source_revision::text,
        true AS present,m.closure_enrollment,n.epoch,n.position,m.closure_export_transaction AS transaction_id
      FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_native_commit n
        ON n.partition_no=m.route/16 AND n.transaction_id=m.closure_export_transaction
      WHERE m.route BETWEEN $1*16 AND $1*16+15 AND m.closure_state IN ('exporting','installed')
        AND (m.route,m.original)>($2::integer,$3::uuid) ORDER BY m.route,m.original LIMIT 100`,
        [partition, cursor.closure_after_route, cursor.closure_after_original],
      )
    ).rows;
    const last = rows.length === 100 ? rows.at(-1) : null;
    await tx.query(
      `UPDATE semantic.identity_epoch_bootstrap_home SET closure_after_route=$2,closure_after_original=$3
      WHERE partition_no=$1`,
      [partition, last?.route ?? partition * 16 - 1, last?.original ?? '00000000-0000-0000-0000-000000000000'],
    );
    return rows;
  });
  for (const row of selected.value)
    await stepIdentityTerminalClosure(
      pool,
      { partition, transactionId: row.transaction_id, epoch: row.epoch, position: BigInt(row.position) },
      [row],
    );
}
