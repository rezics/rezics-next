import { createHash } from 'node:crypto';
import type { WorkContext } from '../work/registry.ts';
import type { WorkClient } from '../work/client.ts';
import {
  withAgentIdentityHistoryUnit,
  currentAgentIdentityHistoryUnit,
  readAgentIdentityRetirementStage,
  type AgentIdentityRetirementStage,
} from '../history/agent-identity-retirement.ts';
import {
  identityHistoryCommand,
  reserveIdentityHistoryWork,
  nativeWork,
  addNativeWork,
  IdentityHistoryWorkUnavailable,
  IDENTITY_HISTORY_COMMAND_CONTROL,
} from '../history/agent-identity-inventory-work.ts';
import {
  AGENT_IDENTITY_HISTORY_GUARD_COST,
  AGENT_IDENTITY_HISTORY_ABSENCE_COST,
} from '../history/agent-identity-sdk-fence.ts';
import type { HistoryReceivingContext } from '../history/receiving.ts';
import type { Pool } from 'pg';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import {
  agentIdentitySourceKey,
  MAX_AGENT_IDENTITY_SOURCE_KEYS,
  type AgentIdentitySourceKey,
} from '../history/agent-identity-source.ts';
import {
  verifyIdentitySourceConsumerCustody,
  type IdentitySourceConsumerCustody,
} from '../semantic/identity-source-consumer-custody.ts';
import { IdentityEpochStoreError } from '../semantic/identity-epoch-store.ts';
import {
  agentIdentityCopyRetention,
  prepareAgentIdentityCopyRetention,
  verifyAgentIdentityCopyRetention,
  verifyAgentIdentityCopyInventory,
  verifyAgentIdentityRecoveryCopyInventory,
  type PreparedAgentIdentityCopy,
} from './shared-history-agent-identity.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import canonicalize from 'canonicalize';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  hasLiveCommandTransaction,
  registerCommandCallback,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contracts.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import * as nativeBinding from '../semantic/identity-epoch-binding.ts';
import type {
  IdentityAdmissionInput,
  IdentityIntent,
  IdentityNativeReceipt,
  IdentityReceipt,
} from '../semantic/identity-epoch-contract.ts';
import type { IdentitySourceConsumerReference } from '../semantic/identity-source-consumer-custody.ts';
import {
  readAccountIdentitySource,
  accountIdentityUnavailable,
  type AccountIdentitySource,
} from './agent-verification-identity.ts';
import select from './agent-verification-identity-technical-read.sql';
import insert from './agent-verification-identity-technical-insert.sql';

type AccountReceipt = Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
// Failure bookkeeping only; all positive authority comes from durable locked native rows.
const wroteTechnical = new WeakSet<CommandTransaction>();
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
const normalized = (value: unknown): string => canonicalize(JSON.parse(json(value)))!;
const keyOf = (receipt: AccountReceipt) => JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
const digestOf = (input: IdentityAdmissionInput) =>
  createHash('sha256')
    .update(normalized([input.intent, input.receipt]))
    .digest('hex');

/** This is a dependency boundary, not a replacement binding implementation. Once the
 * owner delivers the original export, call that export with its original opaque result.
 * Never substitute readIdentityBinding: it performs active admission after T.
 */
type AcceptedReader = (
  tx: CommandTransaction,
  input: IdentityAdmissionInput & { receipt: AccountReceipt },
) => Promise<nativeBinding.IdentityReceiptBinding | null>;
function acceptedReader(): AcceptedReader | null {
  const port = nativeBinding as typeof nativeBinding & {
    readAcceptedAccountIdentityBinding?: AcceptedReader;
  };
  return port.readAcceptedAccountIdentityBinding ?? null;
}

function live(tx: CommandTransaction, receipt: AccountReceipt): boolean {
  if (!hasLiveCommandTransaction(tx)) return false;
  const route = routeOf(receipt.account);
  return (
    route !== null &&
    (receipt.kind === 'account-agent.verify' || receipt.kind === 'account-agent.unverify') &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(receipt.receipt) &&
    currentCommand(tx).partition === partitionOf(route) &&
    currentCommand(tx).basis === null &&
    currentCommandResources(tx).deadline > Date.now()
  );
}

/** Only the Account writer's actual closed branches survive, never arbitrary JSON fields. */
function technicalIntent(value: IdentityIntent, receipt: AccountReceipt): IdentityIntent | null {
  if (receipt.kind === 'account-agent.verify' && value.kind === 'merge')
    return { kind: 'merge', redirected: value.redirected, survivor: value.survivor, release: value.release };
  if (receipt.kind === 'account-agent.unverify' && value.kind === 'unmerge')
    return {
      kind: 'unmerge',
      original: value.original,
      undoJob: { jobId: value.undoJob.jobId, epoch: BigInt(value.undoJob.epoch) },
      verificationReceipt: value.verificationReceipt,
      release: value.release,
    };
  return null;
}

async function accepted(tx: CommandTransaction, input: AccountIdentitySource['input']) {
  const read = acceptedReader();
  if (!read) return null;
  const binding = await read(tx, input);
  if (!binding) return null;
  const data = nativeBinding.identityBindingData(binding);
  return data.state === 'accepted' &&
    data.partition === currentCommand(tx).partition &&
    data.digest === digestOf(input) &&
    data.key === keyOf(input.receipt) &&
    normalized(data.receipt) === normalized(input.receipt)
    ? data
    : null;
}

async function receiver(tx: CommandTransaction, receipt: AccountReceipt) {
  return (await tx.query(select.sql, [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt]))
    .rows[0];
}
type Receiver = NonNullable<Awaited<ReturnType<typeof receiver>>>;
function receiving(row: Receiver): IdentityNativeReceipt {
  return Object.freeze({
    partition: row.source_partition,
    epoch: row.receiving_epoch,
    position: BigInt(row.receiving_position),
    transactionId: row.receiving_transaction_id,
  });
}
function sameReceipt(a: IdentityNativeReceipt, b: IdentityNativeReceipt): boolean {
  return (
    a.partition === b.partition &&
    a.epoch === b.epoch &&
    a.position === b.position &&
    a.transactionId === b.transactionId
  );
}
/** Inventory describes the retained technical fields, never the original History scope.
 * The sole Account locator in the closed payload is the source Account subject; graph
 * subjects, releases, jobs and receipts retain their own native identity, not actor aliases.
 */
async function inventory(tx: CommandTransaction, receipt: AccountReceipt) {
  const rows = (
    await tx.query<{ account_id: string; roles: number }>(
      `SELECT role_account_id::text AS account_id,roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4
     ORDER BY role_account_id LIMIT 2 FOR SHARE`,
      [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
    )
  ).rows;
  if (rows.length !== 1 || rows[0]!.account_id !== receipt.account || rows[0]!.roles !== ACCOUNT_ROLE_BITS.subject)
    return [];
  return [{ account_id: receipt.account, role: 'subject' }];
}

/** Native-only receiver lookup. It does not recurse through the personal source and cannot
 * mint the ordinary source admission capability. The accepted reader owns the claim lock.
 */
export async function readAccountIdentityTechnicalSource(
  tx: CommandTransaction,
  receipt: AccountReceipt,
): Promise<AccountIdentitySource | null> {
  if (!live(tx, receipt) || !acceptedReader()) return null;
  const row = await receiver(tx, receipt);
  return row ? decodeTechnicalSource(tx, receipt, row) : null;
}

async function decodeTechnicalSource(tx: CommandTransaction, receipt: AccountReceipt, row: Receiver) {
  if (
    row.current_write_state !== 'active' ||
    row.receiving_epoch !== row.current_epoch ||
    String(row.domain_generation) !== row.current_domain ||
    (BigInt(row.current_position) < BigInt(row.receiving_position) &&
      !(
        row.same_transaction &&
        row.receiving_transaction_id === currentCommand(tx).transactionId &&
        BigInt(row.receiving_position) === BigInt(row.current_position) + 1n
      ))
  )
    return null;
  const intent = technicalIntent(row.intent as IdentityIntent, receipt);
  if (!intent) return null;
  const input = Object.freeze({ intent: Object.freeze(intent), receipt: Object.freeze({ ...receipt }) });
  const binding = await accepted(tx, input);
  if (
    !binding ||
    binding.job.jobId !== row.accepted_job_id ||
    binding.job.epoch !== BigInt(row.accepted_job_epoch) ||
    binding.generation !== String(row.binding_generation) ||
    binding.transactionId !== row.binding_transaction_id ||
    binding.digest !== row.source_digest ||
    normalized(row.intent) !== normalized(intent)
  )
    return null;
  const roles = await inventory(tx, receipt);
  if (!roles.length) return null;
  return Object.freeze({
    input,
    partition: row.source_partition,
    epoch: row.source_epoch,
    position: BigInt(row.source_position),
    transactionId: row.source_transaction_id,
    digest: row.source_digest,
    workflowId: row.workflow_id,
    roles: Object.freeze(roles.map((role) => Object.freeze(role))),
  });
}

/** Receiving custody proves exact accepted technical identity. Source's already-bound
 * reference/terminal receipt owns barrier, erased-role and root/copy authority.
 */
function matchesTechnical(reference: IdentitySourceConsumerReference, source: AccountIdentitySource): boolean {
  return (
    sameReceipt(reference.source, source) &&
    reference.sourceDigest === source.digest &&
    normalized(reference.receipt) === normalized(source.input.receipt)
  );
}

/** Only first acceptance needs the genuine original personal-role association. */
function matchesOriginal(reference: IdentitySourceConsumerReference, source: AccountIdentitySource): boolean {
  const { barrier } = reference;
  const role = { subject: 'subject', requester: 'actor', decider: 'editor' }[reference.erasedRole];
  return (
    matchesTechnical(reference, source) &&
    routeOf(barrier.accountId) === barrier.accountRoute &&
    Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 &&
    Number.isFinite(Date.parse(barrier.at)) &&
    source.roles.some((r) => r.account_id === barrier.accountId && r.role === role)
  );
}

export async function acceptTechnicalSource(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
): Promise<IdentityNativeReceipt | null> {
  const refuse = (): null => {
    if (wroteTechnical.has(tx)) throw accountIdentityUnavailable('technical receiver mismatch after write');
    return null;
  };
  if (!live(tx, reference.receipt) || !acceptedReader()) return refuse();
  const prior = await receiver(tx, reference.receipt);
  if (prior) {
    const receipt = receiving(prior);
    return (await verifyTechnicalSource(tx, reference, receipt)) ? receipt : refuse();
  }
  let source: AccountIdentitySource;
  try {
    source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'identity_epoch_unavailable') return refuse();
    throw error;
  }
  if (!matchesOriginal(reference, source)) return refuse();
  const binding = await accepted(tx, source.input);
  if (!binding || binding.job.jobId !== reference.job.jobId || binding.job.epoch !== reference.job.epoch)
    return refuse();
  const intent = technicalIntent(source.input.intent, reference.receipt);
  if (!intent || normalized(intent) !== normalized(source.input.intent)) return refuse();
  // The conditional INSERT checks the exact original producer header and its current
  // owner/restore generation before any tuple write. No History role/copy scope is read.
  // SQL reserves the locked owner's forthcoming fence, checked against the actual
  // executor outbox by a deferred constraint.
  const row = (
    await tx.query(insert.sql, [
      routeOf(reference.receipt.account),
      reference.receipt.account,
      reference.receipt.kind,
      reference.receipt.receipt,
      json(intent),
      source.digest,
      source.partition,
      source.epoch,
      source.position.toString(),
      source.transactionId,
      reference.job.jobId,
      reference.job.epoch.toString(),
      binding.generation,
      binding.transactionId,
      source.workflowId,
      currentCommand(tx).transactionId,
    ])
  ).rows[0];
  if (!row) return refuse();
  wroteTechnical.add(tx);
  await tx.query(
    `INSERT INTO access.agent_identity_technical_role
     (route,account_id,direction,receipt_id,role_account_id,roles)
     VALUES($1,$2,$3,$4,$2,$5)`,
    [
      routeOf(reference.receipt.account),
      reference.receipt.account,
      reference.receipt.kind,
      reference.receipt.receipt,
      ACCOUNT_ROLE_BITS.subject,
    ],
  );
  registerCommandCallback(tx, async (transactionId) => {
    await tx.query("SELECT set_config('access.identity_technical_transaction',$1,true)", [transactionId]);
    if (transactionId !== row.receiving_transaction_id || !(await verifyTechnicalSource(tx, reference, receiving(row))))
      throw accountIdentityUnavailable('technical receiving finalization changed');
  });
  const receipt = receiving(row);
  if (!(await verifyTechnicalSource(tx, reference, receipt)))
    throw accountIdentityUnavailable('technical receiving verification failed after write');
  return receipt;
}

export async function verifyTechnicalSource(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  native: IdentityNativeReceipt,
): Promise<boolean> {
  if (!live(tx, reference.receipt) || !acceptedReader()) {
    if (wroteTechnical.has(tx)) throw accountIdentityUnavailable('technical receiver mismatch after write');
    return false;
  }
  const row = await receiver(tx, reference.receipt);
  const source = row ? await decodeTechnicalSource(tx, reference.receipt, row) : null;
  const valid =
    !!row &&
    !!source &&
    matchesTechnical(reference, source) &&
    row.accepted_job_id === reference.job.jobId &&
    BigInt(row.accepted_job_epoch) === reference.job.epoch &&
    sameReceipt(receiving(row), native);
  // A false post-write observation must never let Source commit only its terminal half.
  if (!valid && wroteTechnical.has(tx)) throw accountIdentityUnavailable('technical receiver mismatch after write');
  return valid;
}

export type { AgentIdentitySourceKey } from '../history/agent-identity-source.ts';
export type AgentIdentitySourceRole = 'account_id' | 'requested_by' | 'decided_by';
export const MAX_AGENT_IDENTITY_RETENTION_KEYS = MAX_AGENT_IDENTITY_SOURCE_KEYS;

/** A pending consumer branch, never a declaration that the installed owner is a stub.
 * Only the original Source read and same-command verifier can settle this dependency.
 */
export type AgentIdentityConsumerCustodyPending = Readonly<{
  state: 'pending';
  dependency: 'semantic.identity-epoch.account-source-terminal-custody';
}>;
export const agentIdentityConsumerCustody: AgentIdentityConsumerCustodyPending = Object.freeze({
  state: 'pending',
  dependency: 'semantic.identity-epoch.account-source-terminal-custody',
});

export type AgentIdentityRetentionPending = Readonly<{
  state: 'pending';
  key: AgentIdentitySourceKey;
  gap:
    | 'native-erasure-root-unavailable'
    | 'native-source-missing'
    | 'native-source-role-unavailable'
    | 'native-source-owner-unavailable'
    | 'native-erasure-source-home-root-custody-unavailable'
    | 'native-source-job-unavailable'
    | 'native-source-copies-pending'
    | 'native-source-recovery-copies-unavailable'
    | 'identity-history-native-funding-unavailable'
    | 'identity-history-current-unit-unavailable'
    | AgentIdentityConsumerCustodyPending['dependency'];
  copies: ReturnType<typeof agentIdentityCopyRetention>;
  receiving?: 'unavailable' | 'verified';
}>;

export type AgentIdentityRetentionResult =
  | AgentIdentityRetentionPending
  | Readonly<{
      state: 'minimized';
      key: AgentIdentitySourceKey;
      gap: null;
      copies: ReturnType<typeof agentIdentityCopyRetention>;
      receiving: 'verified';
    }>;
export type AgentIdentityRetentionDependencies = Pick<WorkContext, 'client' | 'env' | 'clock'>;

type NativeSource = {
  account_id: string;
  requested_by: string | null;
  decided_by: string | null;
  source_partition: number;
  source_epoch: number;
  source_position: string;
  source_transaction_id: string;
  intent_digest: string;
  minimized: boolean;
};
export type AgentIdentityRetentionInput = Readonly<{
  barrier: HistoryBarrier;
  role: AgentIdentitySourceRole;
  keys: readonly AgentIdentitySourceKey[];
}>;

function validateInput(input: AgentIdentityRetentionInput): number {
  const { barrier, keys, role } = input;
  if (
    routeOf(barrier.accountId) !== barrier.accountRoute ||
    !Number.isSafeInteger(barrier.version) ||
    barrier.version < 1 ||
    barrier.version > 2147483647 ||
    typeof barrier.at !== 'string' ||
    barrier.at.length > 64 ||
    !Number.isFinite(Date.parse(barrier.at)) ||
    !['account_id', 'requested_by', 'decided_by'].includes(role) ||
    keys.length < 1 ||
    keys.length > MAX_AGENT_IDENTITY_RETENTION_KEYS
  )
    throw new TypeError('Invalid native identity retention request');
  const partition = partitionOf(keys[0]!.route);
  const unique = new Set<string>();
  for (const key of keys) {
    const identity = agentIdentitySourceKey(key);
    if (partitionOf(key.route) !== partition || unique.has(identity))
      throw new TypeError('Identity retention requires at most eight distinct native keys in one home');
    unique.add(identity);
  }
  return partition;
}

/** Current committed root and terminal account, independently of every Source/copy proof.
 * Separate indexed reads avoid a cross-partition join. Locks last through the native command.
 */
async function lockRoot(tx: CommandTransaction, barrier: HistoryBarrier): Promise<boolean> {
  // Neither an indexed foreign read nor a released snapshot carries a live root fence.
  if (currentCommand(tx).partition !== partitionOf(barrier.accountRoute)) return false;
  const root = (
    await tx.query<{ version: number; at: string }>(
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
      [barrier.accountRoute, barrier.accountId],
    )
  ).rows[0];
  if (!root || root.version !== barrier.version || root.at !== barrier.at) return false;
  const account = (
    await tx.query<{ state: string; authn_fenced: boolean }>(
      'SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
      [barrier.accountRoute, barrier.accountId],
    )
  ).rows[0];
  if (account?.state !== 'deleted' || !account.authn_fenced) return false;
  const home = (
    await tx.query<{ write_state: string }>('SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [
      partitionOf(barrier.accountRoute),
    ])
  ).rows[0];
  return home?.write_state === 'active';
}

/** Native preparation/validator only. It deliberately cannot mint foreign consumer or copy custody.
 * No discovery EOF, missing row, caller flag or current Actor can release the original source.
 * At most eight exact native keys; no history, JSON or role-prefix scan and no second coordinator.
 */
export async function prepareAgentIdentityRetention(
  tx: CommandTransaction,
  input: AgentIdentityRetentionInput,
): Promise<readonly AgentIdentityRetentionResult[]> {
  validateInput(input);
  const { pool, deadline } = currentCommandResources(tx);
  // This public validator may be reached directly inside a Source callback, without
  // minimizeAgentIdentityRetention's released command prepayment. Its caller owns
  // command controls; this entry still owes its own root/owner/key reads each time.
  await reserveIdentityHistoryWork(
    pool,
    nativeWork(4 + input.keys.length, 4 + input.keys.length, 4 + input.keys.length, 16384),
    { deadline },
  );
  return prepareNativeRetention(tx, input);
}

type StagedRetention = Readonly<{
  reference: IdentitySourceConsumerReference | null;
  custody: IdentitySourceConsumerCustody | null;
  copy: PreparedAgentIdentityCopy;
  stage: AgentIdentityRetirementStage | null;
  client: WorkClient;
}>;

async function prepareNativeRetention(
  tx: CommandTransaction,
  input: AgentIdentityRetentionInput,
  staged?: readonly (StagedRetention | null)[],
): Promise<readonly AgentIdentityRetentionResult[]> {
  const partition = validateInput(input);
  const command = currentCommand(tx);
  if (command.partition !== partition || command.basis !== null)
    throw new TypeError('Identity retention requires the native platform source home');
  const deadline = currentCommandResources(tx).deadline;
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw new Error('Identity retention command deadline expired');
  };
  checkDeadline();
  if (partition !== partitionOf(input.barrier.accountRoute))
    return Object.freeze(
      input.keys.map((key) =>
        Object.freeze({
          state: 'pending' as const,
          key: Object.freeze({ ...key }),
          gap: 'native-erasure-source-home-root-custody-unavailable' as const,
          copies: agentIdentityCopyRetention(),
        }),
      ),
    );
  if (staged)
    await reserveIdentityHistoryWork(
      currentCommandResources(tx).pool,
      nativeWork(4 + input.keys.length, 4 + input.keys.length, 4 + input.keys.length, 16384),
    );
  const root = await lockRoot(tx, input.barrier);
  const home = root
    ? (
        await tx.query<{
          epoch: number;
          position: string;
          write_state: string;
        }>('SELECT epoch,position::text,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [partition])
      ).rows[0]
    : undefined;
  const preparedResults: AgentIdentityRetentionResult[] = [];
  for (const [index, key] of input.keys.entries()) {
    checkDeadline();
    let gap: AgentIdentityRetentionPending['gap'] = 'native-erasure-root-unavailable';
    let receiving: AgentIdentityRetentionPending['receiving'];
    let copies = agentIdentityCopyRetention(staged?.[index]?.copy);
    if (root) {
      const row = (
        await tx.query<NativeSource>(
          `SELECT account_id,requested_by,decided_by,source_partition,source_epoch,source_position::text,
           source_transaction_id,intent_digest,minimized
         FROM access.agent_identity_intent
         WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4 FOR UPDATE`,
          [key.route, key.accountId, key.direction, key.receiptId],
        )
      ).rows[0];
      gap = !row
        ? 'native-source-missing'
        : row[input.role] !== input.barrier.accountId
          ? 'native-source-role-unavailable'
          : !home ||
              home.write_state !== 'active' ||
              row.source_partition !== partition ||
              row.source_epoch !== home.epoch ||
              BigInt(row.source_position) > BigInt(home.position) ||
              row.minimized ||
              !/^[0-9a-f]{64}$/.test(row.intent_digest)
            ? 'native-source-owner-unavailable'
            : agentIdentityConsumerCustody.dependency;
      const prepared = staged?.[index];
      if (row && prepared && gap === agentIdentityConsumerCustody.dependency) {
        const { reference, custody, copy } = prepared;
        // Bind the released original component again under the live source/root/owner locks.
        if (!reference) gap = 'native-source-job-unavailable';
        else if (
          reference.source.partition !== row.source_partition ||
          reference.source.epoch !== row.source_epoch ||
          reference.source.position !== BigInt(row.source_position) ||
          reference.source.transactionId !== row.source_transaction_id ||
          reference.sourceDigest !== row.intent_digest
        )
          gap = 'native-source-owner-unavailable';
        else {
          const consumed = custody !== null && (await verifyIdentitySourceConsumerCustody(tx, reference, custody));
          await reserveIdentityHistoryWork(currentCommandResources(tx).pool, nativeWork(72, 72, 12, 20480));
          receiving = (await verifyAgentIdentityCopyRetention(tx, input.barrier, copy)) ? 'verified' : 'unavailable';
          const inventory = await verifyAgentIdentityCopyInventory(
            tx,
            input.barrier,
            key,
            copy,
            prepared.stage ?? undefined,
            prepared.client,
          );
          const recoveryInventory = await verifyAgentIdentityRecoveryCopyInventory(tx, input.barrier, key, copy);
          copies = agentIdentityCopyRetention(copy, inventory, recoveryInventory);
          gap = consumed ? 'native-source-copies-pending' : agentIdentityConsumerCustody.dependency;
          if (consumed && receiving === 'verified' && inventory.state === 'verified') {
            if (recoveryInventory.state !== 'verified') gap = 'native-source-recovery-copies-unavailable';
            else {
              const { pool } = currentCommandResources(tx);
              // A sealed recovery causes two guarded UPDATEs. Both independently recheck the
              // original closure and recovery cut before the shared transaction can commit.
              await reserveIdentityHistoryWork(
                pool,
                copy.recoveryInventory.state === 'sealed'
                  ? AGENT_IDENTITY_ROLE_TRANSITION_RECOVERY_COST
                  : AGENT_IDENTITY_ROLE_TRANSITION_COST,
              );
              if (copy.recoveryInventory.state === 'sealed') {
                const recoveryChanged = await tx.query(
                  `UPDATE access.agent_identity_recovery SET
                     requested_by=CASE WHEN requested_by=$5 THEN NULL ELSE requested_by END,
                     decided_by=CASE WHEN decided_by=$5 THEN NULL ELSE decided_by END,
                     original_source=CASE WHEN $6='account_id'
                       THEN access.agent_identity_recovery_skeleton(original_source) ELSE original_source END,
                     original_source_minimized=original_source_minimized OR ($6='account_id' AND original_source IS NOT NULL)
                   WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
                  [key.route, key.accountId, key.direction, key.receiptId, input.barrier.accountId, input.role],
                );
                if (recoveryChanged.rowCount !== 1)
                  throw new Error('Identity recovery source changed after verification');
              }
              const changed = await tx.query(
                `UPDATE access.agent_identity_intent
                SET requested_by=CASE WHEN requested_by=$5 THEN NULL ELSE requested_by END,
                    decided_by=CASE WHEN decided_by=$5 THEN NULL ELSE decided_by END,
                    reason=CASE WHEN decided_by=$5 THEN NULL ELSE reason END,
                    intent=CASE WHEN $6='account_id' THEN '{}'::jsonb ELSE intent END,
                    minimized=minimized OR $6='account_id'
                WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
                [key.route, key.accountId, key.direction, key.receiptId, input.barrier.accountId, input.role],
              );
              if (changed.rowCount !== 1) throw new Error('Identity retention source changed after verification');
              // Do not re-read the destroyed payload as authority. Native trigger locks
              // and Source's original handoff survive this actual command COMMIT.
              preparedResults.push(
                Object.freeze({
                  state: 'minimized',
                  key: Object.freeze({ ...key }),
                  gap: null,
                  copies,
                  receiving: 'verified',
                }),
              );
              continue;
            }
          }
        }
      }
    }
    preparedResults.push(
      Object.freeze({
        state: 'pending',
        key: Object.freeze({ ...key }),
        gap,
        copies,
        ...(receiving ? { receiving } : {}),
      }),
    );
  }
  checkDeadline();
  return Object.freeze(preparedResults);
}

/** Resolve the actual current job without admitting a receipt or substituting the reversal's
 * prior undoJob. Source reads and foreign binding reads each release their checkout.
 */
async function consumerReference(
  pool: Pool,
  input: AgentIdentityRetentionInput,
  key: AgentIdentitySourceKey,
  deadline: number,
): Promise<IdentitySourceConsumerReference | null> {
  const receipt = {
    kind: key.direction,
    account: key.accountId,
    receipt: key.receiptId,
  };
  try {
    await reserveIdentityHistoryWork(pool, nativeWork(70, 68, 25, 73984));
    const source = (
      await runCommand(pool, { partition: partitionOf(key.route), deadline }, async (tx) =>
        noEffect(await readAccountIdentitySource(tx, receipt, undefined, true)),
      )
    ).value;
    const { readOriginalAccountAgentIdentity } = await import('../semantic/account-agent-identity-recovery.ts');
    const accepted = await readOriginalAccountAgentIdentity(pool, {
      account: receipt.account,
      direction: receipt.kind,
      receipt: receipt.receipt,
    });
    if (!accepted || accepted.digest !== source.digest) return null;
    const job = accepted.job;
    const role = {
      account_id: 'subject',
      requested_by: 'requester',
      decided_by: 'decider',
    } as const;
    return Object.freeze({
      receipt,
      job,
      source: {
        partition: source.partition,
        epoch: source.epoch,
        position: source.position,
        transactionId: source.transactionId,
      },
      sourceDigest: source.digest,
      barrier: input.barrier,
      erasedRole: role[input.role],
    });
  } catch (error) {
    if (error instanceof IdentityEpochStoreError && error.code === 'identity_epoch_unavailable') return null;
    throw error;
  }
}

// Exact recovery guard SQL: six fixed point reads, the 33-row consumer sentinel, the
// three-copy sentinel, and two successful locator/proof pairs of at most 65+1 rows each.
// Its 12 SQL statements are the six fixed reads, consumer/copy scans and two locator/proof
// pairs. Search enrollment is intentionally absent: no current Search owner seam is installed.
export const AGENT_IDENTITY_RECOVERY_RETENTION_CHECK_COST = nativeWork(174, 174, 12, 65536);
export const AGENT_IDENTITY_ROLE_TRANSITION_COST = addNativeWork(
  nativeWork(460, 460, 50, 180224),
  AGENT_IDENTITY_HISTORY_GUARD_COST,
  AGENT_IDENTITY_HISTORY_ABSENCE_COST,
);
export const AGENT_IDENTITY_ROLE_TRANSITION_RECOVERY_COST = addNativeWork(
  AGENT_IDENTITY_ROLE_TRANSITION_COST,
  AGENT_IDENTITY_ROLE_TRANSITION_COST,
  AGENT_IDENTITY_RECOVERY_RETENTION_CHECK_COST,
  AGENT_IDENTITY_RECOVERY_RETENTION_CHECK_COST,
);

/** Bounded native role minimizer. Foreign probes release before the final home
 * command. The original Source frame remains live through the guarded COMMIT. */
export function minimizeAgentIdentityRetention(
  pool: Pool,
  input: AgentIdentityRetentionInput,
  deps?: AgentIdentityRetentionDependencies,
): Promise<readonly AgentIdentityRetentionResult[]> {
  const partition = validateInput(input);
  const fixed = structuredClone(input);
  const deadline = Math.min(deadlineFor(5000), Date.now() + 5000);
  const pending = (gap: AgentIdentityRetentionPending['gap']) =>
    fixed.keys.map((key) =>
      Object.freeze({
        state: 'pending' as const,
        key,
        gap,
        copies: agentIdentityCopyRetention(),
      }),
    );
  return withRequestDeadline(deadline, async () => {
    try {
      // Pool-only compatibility never allocates a frame or pretends to possess an SDK client.
      const unit = currentAgentIdentityHistoryUnit();
      const client = deps?.client ?? unit?.client;
      if (!client) {
        await reserveIdentityHistoryWork(
          pool,
          addNativeWork(
            IDENTITY_HISTORY_COMMAND_CONTROL,
            nativeWork(4 + fixed.keys.length, 4 + fixed.keys.length, 4 + fixed.keys.length, 16384),
          ),
          { deadline },
        );
        return withSingleCommandAttempt(
          async () =>
            (
              await runCommand(pool, { partition, deadline }, async (tx) =>
                noEffect(await prepareNativeRetention(tx, fixed)),
              )
            ).value,
        );
      }
      const execute = async (context: HistoryReceivingContext) => {
        if (partition !== 0 || partitionOf(fixed.barrier.accountRoute) !== partition)
          return pending('native-erasure-source-home-root-custody-unavailable');
        const initial = await identityHistoryCommand(pool, context, async (tx) => {
          await reserveIdentityHistoryWork(
            pool,
            nativeWork(4 + fixed.keys.length, 4 + fixed.keys.length, 4 + fixed.keys.length, 16384),
          );
          return prepareNativeRetention(tx, fixed);
        });
        const staged: (StagedRetention | null)[] = [];
        for (const item of initial) {
          if (item.gap !== agentIdentityConsumerCustody.dependency) {
            staged.push(null);
            continue;
          }
          await reserveIdentityHistoryWork(pool, nativeWork(86, 80, 59, 205920));
          const reference = await consumerReference(pool, fixed, item.key, context.deadline);
          const stage = reference ? await readAgentIdentityRetirementStage(pool, reference, context) : null;
          const copy = await prepareAgentIdentityCopyRetention(pool, fixed.barrier, item.key, context.deadline, {
            client,
            context,
          });
          staged.push({
            reference,
            custody: stage?.consumer ?? null,
            stage,
            copy,
            client,
          });
        }
        return identityHistoryCommand(pool, context, (tx) => prepareNativeRetention(tx, fixed, staged));
      };
      // Reuse an existing callback frame; nested/replacement frames are forbidden.
      if (unit) return await execute(unit.context);
      if (!deps) return pending('identity-history-current-unit-unavailable');
      return await withAgentIdentityHistoryUnit({ pool, ...deps }, { deadline }, execute);
    } catch (error) {
      if (error instanceof IdentityHistoryWorkUnavailable)
        return pending('identity-history-native-funding-unavailable');
      throw error;
    }
  });
}
