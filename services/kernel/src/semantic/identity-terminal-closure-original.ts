import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { currentCommand, currentCommandResources, noEffect, runCommand, withSingleCommandAttempt } from '../command/command.ts';
import { COMMAND_DISPATCH_ALLOWANCE, withCommandDispatchLifetime } from '../command/dispatch-lifetime.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { reserveIdentityTerminalOriginalCopies } from './identity-epoch-mapping.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';
import deleteEmptySlot from './identity-terminal-closure-delete-empty-slot.sql';
import { checkIdentityTerminalArbiter, identityTerminalArbiter, withIdentityTerminalArbiter } from './identity-terminal-closure-arbiter.ts';
import { addIdentityTerminalCosts, IDENTITY_TERMINAL_AXES, IDENTITY_TERMINAL_OWNER_READ_PLAN,
  IDENTITY_TERMINAL_OWNER_READ_TOTAL } from './identity-terminal-closure-cost.ts';

/** Opaque handle; copying its fields never copies the private native admission. */
export type IdentityTerminalOriginal = Readonly<{ id: string }>;
type State = {
  handle: IdentityTerminalOriginal;
  pool: Pool;
  proof: IdentityNativeReceipt;
  deadline: number;
  live: boolean;
  inFlight: boolean;
  spent: boolean;
  retiring: boolean;
};
type OriginalRow = {
  original_id: string;
  source_transaction: string;
  source_epoch: number;
  source_position: string;
  source_generation: string;
  source_phase: string;
  deadline: string;
  plan_digest: Buffer;
  price: string[];
  spent: string[];
  ordinal: number;
  reservation: string;
};
const handles = new WeakMap<object, State>();
const callbacks = new AsyncLocalStorage<State>();
const planDigest = createHash('sha256').update(JSON.stringify(IDENTITY_TERMINAL_OWNER_READ_PLAN)).digest();
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const vector = (cost: WorkDimensions) => IDENTITY_TERMINAL_AXES.map((axis) => String(cost[axis]));
const admission = IDENTITY_TERMINAL_OWNER_READ_PLAN.admission;
const dispatch = addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.debit, IDENTITY_TERMINAL_OWNER_READ_PLAN.effect);
const identity = (proof: IdentityNativeReceipt) => {
  const digest = createHash('sha256').update(JSON.stringify([
    'bootstrap-owner-read', proof.partition, proof.epoch, proof.position.toString(), proof.transactionId,
  ])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

function validate(handle: IdentityTerminalOriginal): State {
  const state = handles.get(handle);
  if (!state || state.handle !== handle || callbacks.getStore() !== state || !state.live || Date.now() >= state.deadline)
    throw unavailable('Closed, copied, escaped or expired terminal original');
  return state;
}

/** Actual retained page + native commit + current incarnation. This is admission
 * identity validation, not a released observation authorizing a source write.
 * The owner lock remains held throughout this metadata transaction only.
 */
async function proof(tx: PoolClient, expected: IdentityNativeReceipt, allowAcknowledged = false) {
  const native = identityTerminalArbiter(tx);
  if (native.partition !== expected.partition || native.epoch !== expected.epoch || native.position < expected.position)
    throw unavailable('Terminal original owner incarnation changed');
  const row = (await tx.query<{ generation: string; phase: string; acknowledged: boolean }>(
    `SELECT b.generation::text,b.phase,b.acknowledged FROM semantic.identity_epoch_native_commit n
     JOIN semantic.identity_epoch_bootstrap_page b USING(partition_no,transaction_id)
     WHERE n.partition_no=$1 AND n.transaction_id=$2 AND n.epoch=$3 AND n.position=$4 AND n.purpose='bootstrap'
       AND (NOT b.acknowledged OR $5) FOR SHARE OF n,b`,
    [expected.partition, expected.transactionId, expected.epoch, expected.position.toString(), allowAcknowledged],
  )).rows[0];
  checkIdentityTerminalArbiter(tx);
  if (!row) throw unavailable('No retained native bootstrap position for original');
  // This selected independent producer has no account/basis/copy provenance.
  // A positive role is a different hook profile and is refused, never priced 0.
  const absent = (await tx.query<{ absent: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM semantic.erasure_source_role WHERE partition_no=$1 AND transaction_id=$2)
       AND NOT EXISTS(SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2) AS absent`,
    [expected.partition, expected.transactionId],
  )).rows[0]?.absent;
  checkIdentityTerminalArbiter(tx);
  if (!absent) throw unavailable('Bootstrap original requires nonpersonal native allocator hook profile');
  return row;
}

async function bindProvenance(tx: PoolClient, expected: IdentityNativeReceipt) {
  checkIdentityTerminalArbiter(tx);
  // Existing actual native source identity, never a fabricated command receipt.
  await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [expected.transactionId]);
  checkIdentityTerminalArbiter(tx);
}

async function load(tx: PoolClient, partition: number, id: string): Promise<OriginalRow | undefined> {
  checkIdentityTerminalArbiter(tx);
  const row = (await tx.query<OriginalRow>(
    `SELECT original_id,source_transaction,source_epoch,source_position::text,source_generation::text,
       source_phase,deadline::text,plan_digest,price,spent,ordinal,reservation
     FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2 FOR UPDATE`,
    [partition, id],
  )).rows[0];
  checkIdentityTerminalArbiter(tx);
  return row;
}

function assertPayload(row: OriginalRow, expected: IdentityNativeReceipt, deadline: number, captured: { generation: string; phase: string }) {
  if (row.source_transaction !== expected.transactionId || row.source_epoch !== expected.epoch ||
      row.source_position !== expected.position.toString() || row.source_generation !== captured.generation ||
      row.source_phase !== captured.phase || row.deadline !== String(deadline) || !row.plan_digest.equals(planDigest) ||
      row.price.join(',') !== vector(IDENTITY_TERMINAL_OWNER_READ_TOTAL).join(','))
    throw unavailable('Terminal original immutable payload conflict');
}

/** Commit admission before lending the handle. Replay opens the same record;
 * neither a new callback nor a second Pool connected to this DB refills it.
 * The native source position is verified, not supplied as a successful parent.
 */
export async function withIdentityTerminalBootstrapOriginal<T>(
  pool: Pool, expected: IdentityNativeReceipt, deadline: number,
  body: (original: IdentityTerminalOriginal) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(expected.partition) || expected.partition < 0 || expected.partition > 4095 ||
      !Number.isInteger(expected.epoch) || expected.epoch <= 0 || expected.epoch > 2147483647 ||
      typeof expected.position !== 'bigint' || expected.position <= 0n || expected.position > 9223372036854775807n ||
      typeof expected.transactionId !== 'string' || expected.transactionId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(expected.transactionId))
    throw unavailable('Invalid native original identity');
  // Project exactly the fixed-width receipt; never retain arbitrary caller data.
  const captured = Object.freeze({ partition: expected.partition, epoch: expected.epoch,
    position: expected.position, transactionId: expected.transactionId });
  const id = identity(captured);
  const spent = await withIdentityTerminalArbiter(pool, captured.partition, deadline, async (tx) => {
    const position = await proof(tx, captured, true);
    const existing = await load(tx, captured.partition, id);
    if (existing) {
      assertPayload(existing, captured, deadline, position);
      return existing.ordinal !== 0;
    }
    if (position.acknowledged) throw unavailable('Disposed bootstrap position cannot admit a new original');
    await bindProvenance(tx, captured);
    // Header plus BOTH bounded one-shot tickets are reserved together. Later
    // debit never needs a new slot, hook, provisional copy or fifth participant.
    const allocation = await reserveIdentityTerminalOriginalCopies(tx, id, id, 3);
    checkIdentityTerminalArbiter(tx);
    await tx.query(
      `INSERT INTO semantic.identity_terminal_closure_original(partition_no,original_id,source_transaction,
        source_epoch,source_position,source_generation,source_phase,operation,deadline,plan_digest,price,spent,reservation)
       VALUES($1,$2,$3,$4,$5,$6,$7,'bootstrap-owner-read',$8,$9,$10::bigint[],$11::bigint[],$12)`,
      [captured.partition, id, captured.transactionId, captured.epoch, captured.position.toString(),
        position.generation, position.phase, deadline, planDigest, vector(IDENTITY_TERMINAL_OWNER_READ_TOTAL), vector(admission), allocation],
    );
    checkIdentityTerminalArbiter(tx);
    return false;
  });
  const handle = Object.freeze({ id });
  const state: State = { handle, pool, proof: captured, deadline, live: true, inFlight: false, spent, retiring: false };
  handles.set(handle, state);
  try { return await callbacks.run(state, () => body(handle)); }
  finally { state.live = false; handles.delete(handle); }
}

async function spendOwnerRead(handle: IdentityTerminalOriginal): Promise<void> {
  const state = validate(handle);
  if (state.spent || !state.inFlight) throw unavailable('Terminal owner-read ticket already spent');
  // An uncertain debit cannot be retried by the same live callback. A later
  // authenticated replay must inspect the native monotonic ordinal instead.
  state.spent = true;
  await withIdentityTerminalArbiter(state.pool, state.proof.partition, state.deadline, async (tx) => {
    const row = await load(tx, state.proof.partition, handle.id);
    if (!row) throw unavailable('Terminal original disappeared');
    const owner = identityTerminalArbiter(tx);
    if (owner.epoch !== state.proof.epoch) throw unavailable('Terminal original owner incarnation changed');
    assertPayload(row, state.proof, state.deadline, { generation: row.source_generation, phase: row.source_phase });
    if (row.ordinal !== 0) throw unavailable('Terminal owner-read ticket already durably spent');
    await tx.query(
      `INSERT INTO semantic.identity_terminal_closure_ticket(partition_no,original_id,ordinal,operation,
        effect_partition,phase,cursor_transaction,price,reservation)
       VALUES($1,$2,1,'owner-read',$1,'observe-owner',$3,$4::bigint[],$5)`,
      [state.proof.partition, handle.id, state.proof.transactionId, vector(dispatch), row.reservation],
    );
    checkIdentityTerminalArbiter(tx);
    const debited = await tx.query(
      `UPDATE semantic.identity_terminal_closure_original SET ordinal=1,
        spent=ARRAY[spent[1]+$3::bigint,spent[2]+$4::bigint,spent[3]+$5::bigint,spent[4]+$6::bigint,
          spent[5]+$7::bigint,spent[6]+$8::bigint,spent[7]+$9::bigint,spent[8]+$10::bigint]
       WHERE partition_no=$1 AND original_id=$2 AND ordinal=0 RETURNING ordinal`,
      [state.proof.partition, handle.id, ...vector(dispatch)],
    );
    checkIdentityTerminalArbiter(tx);
    if (debited.rowCount !== 1) throw unavailable('Terminal original debit conflict');
  });
  // Any error after COMMIT, including a lost reply, leaves the DB ticket spent.
  validate(handle);
}

/** Positive, independently composed supported profile. There is exactly one
 * real runCommand in this Core scope, and the actual frozen effect+cleanup
 * allowance is irreversibly debited BEFORE Core checks out its effect client.
 * The result does not settle the original or release physical custody.
 */
export async function readIdentityTerminalOriginalOwner(original: IdentityTerminalOriginal) {
  const state = validate(original);
  if (state.inFlight || state.spent) throw unavailable('No unspent terminal owner-read child');
  state.inFlight = true;
  try {
    const outcome = await withCommandDispatchLifetime(state.pool, state.deadline, {
      original,
      validate() { validate(original); },
      async reserve(allowance) {
        validate(original);
        if (allowance !== COMMAND_DISPATCH_ALLOWANCE) throw unavailable('Changed Core dispatch declaration');
        await spendOwnerRead(original);
        validate(original);
      },
    }, () => withSingleCommandAttempt(() => runCommand(state.pool,
      { partition: state.proof.partition, deadline: state.deadline }, async (tx) => {
        validate(original);
        const command = currentCommand(tx);
        const resources = currentCommandResources(tx);
        if (command.partition !== state.proof.partition || resources.pool !== state.pool || resources.deadline !== state.deadline)
          throw unavailable('Terminal child changed actual executor resources');
        const row = (await tx.query<{ epoch: number; position: string }>(
          `SELECT p.epoch,p.position::text FROM core.partition p
           JOIN semantic.identity_terminal_closure_original o ON o.partition_no=p.partition_no
           JOIN semantic.identity_terminal_closure_ticket t ON t.partition_no=o.partition_no
             AND t.original_id=o.original_id AND t.ordinal=1 AND t.operation='owner-read'
             AND t.phase='observe-owner' AND t.effect_partition=p.partition_no AND t.cursor_transaction=o.source_transaction
           WHERE p.partition_no=$1 AND p.epoch=$2 AND p.write_state='active'
             AND o.original_id=$3 AND o.source_epoch=p.epoch AND o.deadline=$4 AND o.ordinal=1 AND t.price=$5::bigint[]
           FOR SHARE OF p,o,t`,
          [state.proof.partition, state.proof.epoch, original.id, state.deadline, vector(dispatch)],
        )).rows[0];
        validate(original);
        currentCommand(tx);
        if (!row) throw unavailable('Terminal original owner unavailable');
        return noEffect(Object.freeze({ partition: command.partition, epoch: row.epoch, position: BigInt(row.position) }));
      })));
    validate(original);
    return outcome.value;
  } finally { state.inFlight = false; }
}

async function retirementProof(tx: PoolClient, state: State, generation: string) {
  checkIdentityTerminalArbiter(tx);
  const disposed = (await tx.query<{ disposed: boolean }>(
    `SELECT b.acknowledged AND h.generation>=$3::bigint AND NOT EXISTS(
       SELECT 1 FROM semantic.identity_epoch_bootstrap_row r
       WHERE r.partition_no=$1 AND r.transaction_id=$2) AS disposed
     FROM semantic.identity_epoch_bootstrap_page b
     JOIN semantic.identity_epoch_bootstrap_home h USING(partition_no)
     WHERE b.partition_no=$1 AND b.transaction_id=$2 AND b.generation=$3::bigint`,
    [state.proof.partition, state.proof.transactionId, generation],
  )).rows[0]?.disposed;
  checkIdentityTerminalArbiter(tx);
  if (!disposed) throw unavailable('Original retirement requires actual native page ACK and empty payload');
}

/** One prepaid retirement attempt, after actual native progress. It cannot
 * infer settlement from the owner-read result, SDK return or an empty counter.
 * An uncertain/failed retirement keeps its spent ticket and charged copies.
 */
export async function retireIdentityTerminalOriginal(original: IdentityTerminalOriginal): Promise<void> {
  const state = validate(original);
  if (state.inFlight || state.retiring || !state.spent) throw unavailable('Original retirement is not admitted');
  state.inFlight = true;
  state.retiring = true;
  const retirement = addIdentityTerminalCosts(IDENTITY_TERMINAL_OWNER_READ_PLAN.retirementDebit,
    IDENTITY_TERMINAL_OWNER_READ_PLAN.retirementEffect);
  try {
    await withIdentityTerminalArbiter(state.pool, state.proof.partition, state.deadline, async (tx) => {
      const row = await load(tx, state.proof.partition, original.id);
      if (!row) throw unavailable('Original retirement already disposed');
      const owner = identityTerminalArbiter(tx);
      if (owner.epoch !== state.proof.epoch) throw unavailable('Terminal original owner incarnation changed');
      assertPayload(row, state.proof, state.deadline, { generation: row.source_generation, phase: row.source_phase });
      if (row.ordinal !== 1) throw unavailable('Original retirement ticket already durably spent');
      await tx.query(
        `INSERT INTO semantic.identity_terminal_closure_ticket(partition_no,original_id,ordinal,operation,
          effect_partition,phase,cursor_transaction,price,reservation)
         VALUES($1,$2,2,'retire-original',$1,'retire-original',$3,$4::bigint[],$5)`,
        [state.proof.partition, original.id, state.proof.transactionId, vector(retirement), row.reservation],
      );
      checkIdentityTerminalArbiter(tx);
      const debit = await tx.query(
        `UPDATE semantic.identity_terminal_closure_original SET ordinal=2,
          spent=ARRAY[spent[1]+$3::bigint,spent[2]+$4::bigint,spent[3]+$5::bigint,spent[4]+$6::bigint,
            spent[5]+$7::bigint,spent[6]+$8::bigint,spent[7]+$9::bigint,spent[8]+$10::bigint]
         WHERE partition_no=$1 AND original_id=$2 AND ordinal=1 RETURNING ordinal`,
        [state.proof.partition, original.id, ...vector(retirement)],
      );
      checkIdentityTerminalArbiter(tx);
      if (debit.rowCount !== 1) throw unavailable('Original retirement debit conflict');
    });
    validate(original);
    await withIdentityTerminalArbiter(state.pool, state.proof.partition, state.deadline, async (tx) => {
      const captured = await proof(tx, state.proof, true);
      const row = await load(tx, state.proof.partition, original.id);
      if (!row || row.ordinal !== 2) throw unavailable('No exact spent retirement grant');
      assertPayload(row, state.proof, state.deadline, captured);
      await retirementProof(tx, state, row.source_generation);
      const removed = (await tx.query<{ reservation: string }>(
        `DELETE FROM semantic.identity_terminal_closure_ticket WHERE partition_no=$1 AND original_id=$2
           AND effect_partition=$1 AND cursor_transaction=$3
           AND ((ordinal=1 AND operation='owner-read' AND phase='observe-owner' AND price=$4::bigint[])
             OR (ordinal=2 AND operation='retire-original' AND phase='retire-original' AND price=$5::bigint[]))
         RETURNING reservation`, [state.proof.partition, original.id, state.proof.transactionId, vector(dispatch), vector(retirement)],
      )).rows;
      checkIdentityTerminalArbiter(tx);
      if (removed.length !== 2 || removed.some(ticket => ticket.reservation !== row.reservation))
        throw unavailable('Retirement requires both exact spent tickets');
      const deleted = await tx.query(
        `DELETE FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2 AND ordinal=2`,
        [state.proof.partition, original.id],
      );
      checkIdentityTerminalArbiter(tx);
      if (deleted.rowCount !== 1) throw unavailable('Original retirement conflict');
      await bindProvenance(tx, state.proof);
      checkIdentityTerminalArbiter(tx);
      const released = await tx.query(
        `UPDATE semantic.identity_epoch_mapping_generation SET closure_copies=closure_copies-3
         WHERE partition_no=$1 AND generation=$2 AND job_id=$2 AND closure_copies>=3 RETURNING slot`,
        [state.proof.partition, row.reservation],
      );
      checkIdentityTerminalArbiter(tx);
      if (released.rowCount !== 1) throw unavailable('Original physical custody release conflict');
      // Owner and bucket locks still cover the exact native empty ranges. A
      // zero counter alone never authorizes physical retirement.
      await tx.query(deleteEmptySlot.sql, [state.proof.partition, row.reservation]);
      checkIdentityTerminalArbiter(tx);
    });
    validate(original);
    state.live = false;
  } finally { state.inFlight = false; }
}
