import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { currentCommand, currentCommandResources, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-epoch-store.ts';
import { checkIdentityTerminalArbiter, identityTerminalArbiter, withIdentityTerminalArbiter } from './identity-terminal-closure-arbiter.ts';
import { addIdentityTerminalCosts, IDENTITY_TERMINAL_AXES, IDENTITY_TERMINAL_OWNER_READ_PLAN,
  IDENTITY_TERMINAL_OWNER_READ_TOTAL } from './identity-terminal-closure-cost.ts';
import { IDENTITY_TERMINAL_MAINTENANCE_PLAN as plan, IDENTITY_TERMINAL_MAINTENANCE_TOTAL as total } from './identity-terminal-closure-maintenance-cost.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import deleteEmptySlot from './identity-terminal-closure-delete-empty-slot.sql';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const vector = (cost: WorkDimensions) => IDENTITY_TERMINAL_AXES.map(axis => String(cost[axis]));
const digest = createHash('sha256').update(JSON.stringify(plan)).digest();
const rootDigest = createHash('sha256').update(JSON.stringify(IDENTITY_TERMINAL_OWNER_READ_PLAN)).digest();
const ownerDispatch = addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.debit, IDENTITY_TERMINAL_OWNER_READ_PLAN.effect);
const retirement = addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.retirementDebit, IDENTITY_TERMINAL_OWNER_READ_PLAN.retirementEffect);
const dispatch = addIdentityTerminalCosts(plan.debit, plan.effect);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Header = {
  original_id: string; source_transaction: string; source_epoch: number; source_position: string;
  source_generation: string; source_phase: string; operation: string; deadline: string;
  plan_digest: Buffer; price: string[]; spent: string[]; ordinal: number; reservation: string;
  predecessor: string | null; cleanup_id: string | null;
};
type Grant = { generation: string; phase: string; root: string; export_transaction: string };
type Ticket = { ordinal: number; operation: string; effect_partition: number; phase: string;
  cursor_transaction: string; price: string[]; reservation: string };
export type IdentityTerminalMaintenanceOriginal = Readonly<{ id: string }>;
type State = { handle: IdentityTerminalMaintenanceOriginal; pool: Pool; native: IdentityNativeReceipt;
  root: string; deadline: number; live: boolean; inFlight: boolean; spent: boolean };
const handles = new WeakMap<object, State>();
const callbacks = new AsyncLocalStorage<State>();

function validReceipt(receipt: IdentityNativeReceipt) {
  if (!Number.isInteger(receipt.partition) || receipt.partition < 0 || receipt.partition > 4095 ||
      !Number.isInteger(receipt.epoch) || receipt.epoch <= 0 || receipt.epoch > 2147483647 ||
      typeof receipt.position !== 'bigint' || receipt.position <= 0n || receipt.position > 9223372036854775807n ||
      typeof receipt.transactionId !== 'string' || receipt.transactionId.length !== 36 || !uuid.test(receipt.transactionId))
    throw unavailable('Invalid maintenance native identity');
}
const maintenanceId = (native: IdentityNativeReceipt, root: string) => {
  const hex = createHash('sha256').update(JSON.stringify([plan.kind, native.partition, native.epoch,
    native.position.toString(), native.transactionId, root])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
function validate(handle: IdentityTerminalMaintenanceOriginal) {
  const state = handles.get(handle);
  if (!state || state.handle !== handle || !state.live || callbacks.getStore() !== state || Date.now() >= state.deadline)
    throw unavailable('Closed, copied, escaped or expired maintenance original');
  return state;
}

/** Called only inside the actual native ACK/maintenance command. The callback
 * and native commit share its event fence. It does not execute or price Core.
 * Passing a receipt cannot manufacture a grant: both source and producer owner
 * are locked, and the producer's actual transaction ID/next position is used.
 * The installed noEffect/Source-fence profiles do not support these callbacks.
 */
export function recordIdentityTerminalOriginalMaintenance(tx: CommandTransaction, expected: IdentityNativeReceipt): void {
  validReceipt(expected);
  const exported = Object.freeze({ partition: expected.partition, epoch: expected.epoch,
    position: expected.position, transactionId: expected.transactionId });
  const command = currentCommand(tx);
  const resources = currentCommandResources(tx);
  const checkpoint = () => {
    if (currentCommand(tx) !== command || currentCommandResources(tx) !== resources || Date.now() >= resources.deadline)
      throw unavailable('No live native maintenance producer');
  };
  checkpoint();
  if (command.partition !== exported.partition || command.basis !== null)
    throw unavailable('Maintenance requires the native platform source home');
  recordIdentityEpochNativeCommit(tx, 'bootstrap');
  registerCommandCallback(tx, async transactionId => {
    checkpoint();
    if (transactionId !== command.transactionId) throw unavailable('Changed native maintenance transaction');
    const row = (await tx.query<{ root: string; cleanup_id: string | null }>(
      `SELECT o.original_id AS root,o.cleanup_id FROM core.partition p
       JOIN semantic.identity_epoch_bootstrap_page b ON b.partition_no=p.partition_no
       JOIN semantic.identity_epoch_native_commit n ON n.partition_no=b.partition_no AND n.transaction_id=b.transaction_id
       JOIN semantic.identity_terminal_closure_original o ON o.partition_no=b.partition_no
         AND o.source_transaction=b.transaction_id AND o.operation='bootstrap-owner-read'
       WHERE p.partition_no=$1 AND p.epoch=$2 AND p.write_state='active' AND p.position>=$3
         AND b.transaction_id=$4 AND n.epoch=p.epoch AND n.position=$3 AND n.purpose='bootstrap'
         AND o.source_position=n.position AND o.source_generation=b.generation AND o.source_phase=b.phase
         AND b.acknowledged AND NOT b.closure_cleanup_complete AND o.source_epoch=p.epoch
         AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row r
           WHERE r.partition_no=$1 AND r.transaction_id=b.transaction_id)
       FOR UPDATE OF p,b,o`,
      [exported.partition, exported.epoch, exported.position.toString(), exported.transactionId],
    )).rows[0];
    checkpoint();
    if (!row) return; // No admitted predecessor, so no metadata liability to lend.
    if (row.cleanup_id) {
      checkpoint();
      const prior = (await tx.query<{ ordinal: number; deadline: string }>(
        `SELECT ordinal,deadline::text FROM semantic.identity_terminal_closure_original
         WHERE partition_no=$1 AND original_id=$2 AND predecessor=$3 FOR UPDATE`,
        [exported.partition, row.cleanup_id, row.root],
      )).rows[0];
      checkpoint();
      if (!prior) throw unavailable('Missing native maintenance custodian');
      // A stable unspent admitted producer has the opportunity to finish; a
      // scheduler callback cannot evict it by simply inventing another nonce.
      if (prior.ordinal === 0 && BigInt(prior.deadline) > BigInt(Date.now()))
        throw unavailable('Unspent maintenance original still owns cleanup');
    }
    checkpoint();
    const updated = await tx.query(
      `UPDATE semantic.identity_epoch_bootstrap_page b SET closure_cleanup_original=$3,
         closure_cleanup_transaction=$4,closure_cleanup_epoch=p.epoch,closure_cleanup_position=p.position+1,closure_cleanup_deadline=$6
       FROM core.partition p WHERE b.partition_no=$1 AND b.transaction_id=$2 AND p.partition_no=b.partition_no
         AND p.epoch=$5 AND p.write_state='active' AND b.acknowledged AND NOT b.closure_cleanup_complete`,
      [exported.partition, exported.transactionId, row.root, transactionId, exported.epoch, resources.deadline],
    );
    checkpoint();
    if (updated.rowCount !== 1) throw unavailable('Maintenance native grant conflict');
  });
}

async function header(tx: PoolClient, home: number, id: string): Promise<Header | undefined> {
  checkIdentityTerminalArbiter(tx);
  const row = (await tx.query<Header>(
    `SELECT original_id,source_transaction,source_epoch,source_position::text,source_generation::text,source_phase,
       operation,deadline::text,plan_digest,price,spent,ordinal,reservation,predecessor,cleanup_id
     FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2 FOR UPDATE`, [home, id],
  )).rows[0];
  checkIdentityTerminalArbiter(tx);
  return row;
}
function assertRoot(row: Header) {
  if (row.operation !== 'bootstrap-owner-read' || row.predecessor !== null || !row.plan_digest.equals(rootDigest) ||
      row.price.join(',') !== vector(IDENTITY_TERMINAL_OWNER_READ_TOTAL).join(','))
    throw unavailable('Unsupported predecessor composition');
  const expected = row.ordinal === 0 ? IDENTITY_TERMINAL_OWNER_READ_PLAN.admission : row.ordinal === 1 ?
    addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.admission, ownerDispatch) : null;
  // ordinal=2 may be the old spent retirement or explicit transfer revocation.
  const allowed = expected ? [vector(expected).join(',')] : [
    vector(IDENTITY_TERMINAL_OWNER_READ_PLAN.admission).join(','),
    vector(addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.admission, ownerDispatch)).join(','),
    vector(IDENTITY_TERMINAL_OWNER_READ_TOTAL).join(','),
  ];
  if (!allowed.includes(row.spent.join(','))) throw unavailable('Unsupported predecessor spent state');
}
function assertMaintenance(row: Header, native: IdentityNativeReceipt, root: Header, deadline?: number) {
  if (row.operation !== plan.kind || row.predecessor !== root.original_id || row.cleanup_id !== null ||
      row.source_epoch !== native.epoch || row.source_transaction !== native.transactionId ||
      row.source_position !== native.position.toString() || row.source_generation !== root.source_generation ||
      row.source_phase !== root.source_phase || row.reservation !== root.reservation ||
      row.original_id !== maintenanceId(native, root.original_id) || !row.plan_digest.equals(digest) ||
      row.price.join(',') !== vector(total).join(',') || (deadline !== undefined && row.deadline !== String(deadline)) ||
      row.ordinal > 1 || row.spent.join(',') !== vector(row.ordinal === 0 ? plan.admission : total).join(','))
    throw unavailable('Maintenance immutable payload conflict');
}
async function tickets(tx: PoolClient, home: number, id: string): Promise<Ticket[]> {
  checkIdentityTerminalArbiter(tx);
  const rows = (await tx.query<Ticket>(
    `SELECT ordinal,operation,effect_partition,phase,cursor_transaction,price,reservation
     FROM semantic.identity_terminal_closure_ticket WHERE partition_no=$1 AND original_id=$2 ORDER BY ordinal FOR UPDATE`,
    [home, id],
  )).rows;
  checkIdentityTerminalArbiter(tx);
  return rows;
}
function assertTickets(rows: Ticket[], root: Header, home: number, maintenance = false) {
  const expected = maintenance ? root.ordinal : root.cleanup_id === null ? root.ordinal : 0;
  if (rows.length !== expected || rows.some((t, i) => t.ordinal !== i + 1 || t.effect_partition !== home ||
      t.cursor_transaction !== root.source_transaction || t.reservation !== root.reservation ||
      t.operation !== (maintenance ? 'cleanup-predecessor' : i === 0 ? 'owner-read' : 'retire-original') ||
      t.phase !== (maintenance ? 'cleanup-predecessor' : i === 0 ? 'observe-owner' : 'retire-original') ||
      t.price.join(',') !== vector(maintenance ? dispatch : i === 0 ? ownerDispatch : retirement).join(',')))
    throw unavailable('Maintenance requires exact retained spent tickets');
}
async function grant(tx: PoolClient, native: IdentityNativeReceipt, rootId: string, deadline: number): Promise<Grant> {
  const owner = identityTerminalArbiter(tx);
  if (owner.partition !== native.partition || owner.epoch !== native.epoch || owner.position < native.position)
    throw unavailable('Maintenance owner incarnation changed');
  const row = (await tx.query<Grant>(
    `SELECT b.generation::text,b.phase,o.original_id AS root,b.transaction_id AS export_transaction
     FROM semantic.identity_terminal_closure_original o
     JOIN semantic.identity_epoch_bootstrap_page b ON b.partition_no=o.partition_no AND b.transaction_id=o.source_transaction
     JOIN semantic.identity_epoch_native_commit n ON n.partition_no=b.partition_no AND n.transaction_id=b.closure_cleanup_transaction
     JOIN semantic.identity_epoch_native_commit s ON s.partition_no=b.partition_no AND s.transaction_id=b.transaction_id
       AND s.epoch=o.source_epoch AND s.position=o.source_position AND s.purpose='bootstrap'
     JOIN semantic.identity_epoch_bootstrap_home h ON h.partition_no=b.partition_no
     WHERE o.partition_no=$1 AND o.original_id=$2 AND o.operation='bootstrap-owner-read' AND o.source_epoch=$3
       AND o.source_generation=b.generation AND o.source_phase=b.phase
       AND b.closure_cleanup_original=o.original_id AND b.closure_cleanup_transaction=$4
       AND b.closure_cleanup_epoch=$3 AND b.closure_cleanup_position=$5 AND NOT b.closure_cleanup_complete
       AND b.closure_cleanup_deadline=$6::bigint
       AND n.epoch=$3 AND n.position=$5 AND n.purpose='bootstrap' AND b.acknowledged AND h.generation>=b.generation
       AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row r
         WHERE r.partition_no=$1 AND r.transaction_id=b.transaction_id) FOR SHARE OF b,n,s,h,o`,
    [native.partition, rootId, native.epoch, native.transactionId, native.position.toString(), deadline],
  )).rows[0];
  checkIdentityTerminalArbiter(tx);
  if (!row) throw unavailable('No current native ACK maintenance grant');
  const absent = (await tx.query<{ absent: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM semantic.erasure_source_role WHERE partition_no=$1 AND transaction_id=$2)
       AND NOT EXISTS(SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2) AS absent`,
    [native.partition, native.transactionId],
  )).rows[0]?.absent;
  checkIdentityTerminalArbiter(tx);
  if (!absent) throw unavailable('Maintenance requires the nonpersonal native hook profile');
  return row;
}
async function reservation(tx: PoolClient, home: number, id: string) {
  checkIdentityTerminalArbiter(tx);
  const row = (await tx.query(
    `SELECT g.slot FROM semantic.identity_epoch_mapping_generation g WHERE g.partition_no=$1 AND g.generation=$2
       AND g.job_id=$2 AND g.closure_source_pool AND g.closure_copies>=3 AND g.closure_copies<=4096
       AND NOT EXISTS(SELECT 1 FROM semantic.erasure_copy_role r WHERE r.partition_no=$1
         AND r.store='identity_epoch_mapping_generation' AND r.record_key=g.erasure_key)
     FOR UPDATE OF g`, [home, id],
  )).rows[0];
  checkIdentityTerminalArbiter(tx);
  if (!row) throw unavailable('No exact charged maintenance bundle');
}
async function removeTickets(tx: PoolClient, home: number, id: string, count: number) {
  checkIdentityTerminalArbiter(tx);
  const result = await tx.query(`DELETE FROM semantic.identity_terminal_closure_ticket WHERE partition_no=$1 AND original_id=$2`, [home, id]);
  checkIdentityTerminalArbiter(tx);
  if (result.rowCount !== count) throw unavailable('Maintenance ticket custody conflict');
}

/** A separate real native producer, not a new callback of the old original.
 * Admission commits before the private handle escapes. Its two roles replace
 * the predecessor's two provisional/spent tickets in the SAME three-copy
 * bundle; there is no allocation, refund, extra slot or transient fourth copy.
 */
export async function withIdentityTerminalMaintenanceOriginal<T>(pool: Pool, expected: IdentityNativeReceipt,
  rootId: string, deadline: number, body: (original: IdentityTerminalMaintenanceOriginal) => Promise<T>): Promise<T> {
  validReceipt(expected);
  if (typeof rootId !== 'string' || rootId.length !== 36 || !uuid.test(rootId)) throw unavailable('Invalid maintenance predecessor');
  const native = Object.freeze({ partition: expected.partition, epoch: expected.epoch,
    position: expected.position, transactionId: expected.transactionId });
  const id = maintenanceId(native, rootId);
  const spent = await withIdentityTerminalArbiter(pool, native.partition, deadline, async tx => {
    const current = await grant(tx, native, rootId, deadline);
    const root = await header(tx, native.partition, rootId);
    if (!root || root.source_generation !== current.generation || root.source_phase !== current.phase) throw unavailable('Missing predecessor custody');
    assertRoot(root);
    await reservation(tx, native.partition, root.reservation);
    const prior = root.cleanup_id ? await header(tx, native.partition, root.cleanup_id) : undefined;
    if (root.cleanup_id === id) {
      if (!prior) throw unavailable('Missing admitted maintenance original');
      assertMaintenance(prior, native, root, deadline);
      return prior.ordinal !== 0;
    }
    if (root.cleanup_id) {
      if (!prior) throw unavailable('Missing prior maintenance original');
      // Its exact old proof remains immutable even though a newer actual native
      // grant revoked it. Replacement is custody transfer, never a refill.
      assertMaintenance(prior, { partition: native.partition, epoch: prior.source_epoch,
        position: BigInt(prior.source_position), transactionId: prior.source_transaction }, root);
      if (prior.ordinal === 0 && BigInt(prior.deadline) > BigInt(Date.now())) throw unavailable('Unspent maintenance still owns custody');
      const oldTickets = await tickets(tx, native.partition, prior.original_id);
      assertTickets(oldTickets, prior, native.partition, true);
      await removeTickets(tx, native.partition, prior.original_id, oldTickets.length);
      checkIdentityTerminalArbiter(tx);
      const removed = await tx.query(`DELETE FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1 AND original_id=$2 AND predecessor=$3`, [native.partition, prior.original_id, rootId]);
      checkIdentityTerminalArbiter(tx);
      if (removed.rowCount !== 1) throw unavailable('Prior maintenance transfer conflict');
    } else {
      const oldTickets = await tickets(tx, native.partition, rootId);
      assertTickets(oldTickets, root, native.partition);
      await removeTickets(tx, native.partition, rootId, oldTickets.length);
    }
    checkIdentityTerminalArbiter(tx);
    await tx.query(`INSERT INTO semantic.identity_terminal_closure_original(partition_no,original_id,source_transaction,
      source_epoch,source_position,source_generation,source_phase,operation,deadline,plan_digest,price,spent,reservation,predecessor)
      VALUES($1,$2,$3,$4,$5,$6,$7,'bootstrap-original-maintenance',$8,$9,$10::bigint[],$11::bigint[],$12,$13)`,
    [native.partition, id, native.transactionId, native.epoch, native.position.toString(), root.source_generation, root.source_phase,
      deadline, digest, vector(total), vector(plan.admission), root.reservation, rootId]);
    checkIdentityTerminalArbiter(tx);
    const transferred = await tx.query(`UPDATE semantic.identity_terminal_closure_original SET ordinal=2,cleanup_id=$3
      WHERE partition_no=$1 AND original_id=$2 AND cleanup_id IS NOT DISTINCT FROM $4::uuid`, [native.partition, rootId, id, root.cleanup_id]);
    checkIdentityTerminalArbiter(tx);
    if (transferred.rowCount !== 1) throw unavailable('Predecessor transfer conflict');
    return false;
  });
  const handle = Object.freeze({ id });
  const state: State = { handle, pool, native, root: rootId, deadline, live: true, inFlight: false, spent };
  handles.set(handle, state);
  try { return await callbacks.run(state, () => body(handle)); }
  finally { state.live = false; handles.delete(handle); }
}

async function custody(tx: PoolClient, state: State) {
  await grant(tx, state.native, state.root, state.deadline);
  const root = await header(tx, state.native.partition, state.root);
  if (!root || root.ordinal !== 2 || root.cleanup_id !== state.handle.id) throw unavailable('Maintenance custody was withdrawn');
  assertRoot(root);
  const own = await header(tx, state.native.partition, state.handle.id);
  if (!own) throw unavailable('Missing maintenance original');
  assertMaintenance(own, state.native, root, state.deadline);
  await reservation(tx, state.native.partition, root.reservation);
  return { root, own };
}

/** One committed debit, then one metadata cleanup attempt. Lost responses,
 * failed COMMIT and expired handles retain their spent grant and charged bundle.
 * A fresh native producer can transfer that bundle; no scheduler refills it.
 */
export async function cleanupIdentityTerminalMaintenanceOriginal(original: IdentityTerminalMaintenanceOriginal): Promise<void> {
  const state = validate(original);
  if (state.inFlight || state.spent) throw unavailable('Maintenance cleanup ticket already spent');
  state.inFlight = true;
  state.spent = true;
  try {
    await withIdentityTerminalArbiter(state.pool, state.native.partition, state.deadline, async tx => {
      const { own } = await custody(tx, state);
      if (own.ordinal !== 0) throw unavailable('Maintenance cleanup ticket already durably spent');
      checkIdentityTerminalArbiter(tx);
      await tx.query(`INSERT INTO semantic.identity_terminal_closure_ticket(partition_no,original_id,ordinal,operation,
        effect_partition,phase,cursor_transaction,price,reservation)
        VALUES($1,$2,1,'cleanup-predecessor',$1,'cleanup-predecessor',$3,$4::bigint[],$5)`,
      [state.native.partition, original.id, state.native.transactionId, vector(dispatch), own.reservation]);
      checkIdentityTerminalArbiter(tx);
      const result = await tx.query(`UPDATE semantic.identity_terminal_closure_original SET ordinal=1,spent=$3::bigint[]
        WHERE partition_no=$1 AND original_id=$2 AND ordinal=0`, [state.native.partition, original.id, vector(total)]);
      checkIdentityTerminalArbiter(tx);
      if (result.rowCount !== 1) throw unavailable('Maintenance debit conflict');
    });
    validate(original);
    await withIdentityTerminalArbiter(state.pool, state.native.partition, state.deadline, async tx => {
      const { root, own } = await custody(tx, state);
      if (own.ordinal !== 1) throw unavailable('No spent cleanup grant');
      const spentTickets = await tickets(tx, state.native.partition, own.original_id);
      assertTickets(spentTickets, own, state.native.partition, true);
      await removeTickets(tx, state.native.partition, own.original_id, 1);
      for (const id of [own.original_id, root.original_id]) {
        checkIdentityTerminalArbiter(tx);
        const removed = await tx.query(`DELETE FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2`,
          [state.native.partition, id]);
        checkIdentityTerminalArbiter(tx);
        if (removed.rowCount !== 1) throw unavailable('Cleanup header custody conflict');
      }
      checkIdentityTerminalArbiter(tx);
      const complete = await tx.query(`UPDATE semantic.identity_epoch_bootstrap_page SET closure_cleanup_complete=true
        WHERE partition_no=$1 AND transaction_id=$2 AND closure_cleanup_transaction=$3 AND closure_cleanup_original=$4
          AND closure_cleanup_epoch=$5 AND closure_cleanup_position=$6 AND NOT closure_cleanup_complete`,
      [state.native.partition, root.source_transaction, state.native.transactionId, root.original_id, state.native.epoch, state.native.position.toString()]);
      checkIdentityTerminalArbiter(tx);
      if (complete.rowCount !== 1) throw unavailable('Cleanup disposition conflict');
      await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [state.native.transactionId]);
      checkIdentityTerminalArbiter(tx);
      const released = await tx.query(`UPDATE semantic.identity_epoch_mapping_generation SET closure_copies=closure_copies-3
        WHERE partition_no=$1 AND generation=$2 AND job_id=$2 AND closure_copies>=3 RETURNING slot`, [state.native.partition, root.reservation]);
      checkIdentityTerminalArbiter(tx);
      if (released.rowCount !== 1) throw unavailable('Cleanup physical release conflict');
      await tx.query(deleteEmptySlot.sql, [state.native.partition, root.reservation]);
      checkIdentityTerminalArbiter(tx);
    });
    validate(original);
    state.live = false;
  } finally { state.inFlight = false; }
}
