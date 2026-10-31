import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  currentCommand,
  currentCommandResources,
  hasLiveCommandTransaction,
  registerCommandCallback,
  type CommandTransaction,
} from '../command/command.ts';
import { readAgentIdentityInventoryInTransaction } from '../history/agent-identity-inventory.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contracts.ts';
import { unionHistoryScope } from '../history/record.ts';
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
  createHash('sha256').update(normalized([input.intent, input.receipt])).digest('hex');

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
  return data.state === 'accepted' && data.partition === currentCommand(tx).partition &&
    data.digest === digestOf(input) && data.key === keyOf(input.receipt) &&
    normalized(data.receipt) === normalized(input.receipt)
    ? data : null;
}

async function receiver(tx: CommandTransaction, receipt: AccountReceipt) {
  return (await tx.query(select.sql, [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt])).rows[0];
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
  return a.partition === b.partition && a.epoch === b.epoch && a.position === b.position &&
    a.transactionId === b.transactionId;
}
async function inventory(tx: CommandTransaction, receipt: AccountReceipt) {
  const rows = (await tx.query<{ account_id: string; source_roles: number }>(
    `SELECT role_account_id::text AS account_id,source_roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4
     ORDER BY role_account_id LIMIT 65 FOR SHARE`,
    [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
  )).rows;
  if (!rows.length || rows.length > 64) return [];
  return rows.flatMap((row) => [
    ...(row.source_roles & 1 ? [{ account_id: row.account_id, role: 'subject' }] : []),
    ...(row.source_roles & 2 ? [{ account_id: row.account_id, role: 'actor' }] : []),
    ...(row.source_roles & 4 ? [{ account_id: row.account_id, role: 'editor' }] : []),
  ]);
}

/** Read the genuine bounded serializer role union; source.roles alone omits inherited undo,
 * principals and acting humans. No HistoryArtifact, subject or candidate is synthesized.
 */
async function producerInventory(tx: CommandTransaction, source: AccountIdentitySource) {
  const receipt = source.input.receipt;
  const native = await readAgentIdentityInventoryInTransaction(tx, {
    route: routeOf(receipt.account)!, accountId: receipt.account,
    direction: receipt.kind, receiptId: receipt.receipt,
  });
  if (native.state !== 'sealed' || !sameReceipt(native.proof.original, source) ||
    native.proof.original.digest !== source.digest) return null;
  const accounts = unionHistoryScope('command-receipt/v1',
    ...native.proof.artifacts.map((artifact) => artifact.accounts)).accounts;
  const sourceMask = { subject: 1, actor: 2, editor: 4 };
  const historyMask = { subject: ACCOUNT_ROLE_BITS.subject, actor: ACCOUNT_ROLE_BITS.actor,
    editor: ACCOUNT_ROLE_BITS.reviewer };
  for (const role of source.roles) {
    if (!(role.role in sourceMask)) return null;
    const name = role.role as keyof typeof sourceMask;
    if (!accounts.some((a) => a.accountId === role.account_id && (a.roles & historyMask[name]) !== 0)) return null;
  }
  return {
    domainGeneration: native.proof.domainGeneration,
    accounts: accounts.map((a) => ({ ...a, sourceRoles: source.roles.reduce((mask, role) =>
      role.account_id === a.accountId ? mask | sourceMask[role.role as keyof typeof sourceMask] : mask, 0) })),
  };
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
  if (!row) return null;
  const intent = technicalIntent(row.intent as IdentityIntent, receipt);
  if (!intent) return null;
  const input = Object.freeze({ intent: Object.freeze(intent), receipt: Object.freeze({ ...receipt }) });
  const binding = await accepted(tx, input);
  if (!binding || binding.job.jobId !== row.accepted_job_id || binding.job.epoch !== BigInt(row.accepted_job_epoch) ||
    binding.generation !== String(row.binding_generation) || binding.transactionId !== row.binding_transaction_id ||
    binding.digest !== row.source_digest || normalized(row.intent) !== normalized(intent)) return null;
  const roles = await inventory(tx, receipt);
  if (!roles.length || roles.length > 8 || !roles.some((r) => r.account_id === receipt.account && r.role === 'subject'))
    return null;
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

function matches(reference: IdentitySourceConsumerReference, source: AccountIdentitySource): boolean {
  const { barrier } = reference;
  const role = { subject: 'subject', requester: 'actor', decider: 'editor' }[reference.erasedRole];
  return sameReceipt(reference.source, source) && reference.sourceDigest === source.digest &&
    normalized(reference.receipt) === normalized(source.input.receipt) &&
    routeOf(barrier.accountId) === barrier.accountRoute && Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 && Number.isFinite(Date.parse(barrier.at)) &&
    source.roles.some((r) => r.account_id === barrier.accountId && r.role === role);
}

export async function acceptTechnicalSource(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
): Promise<IdentityNativeReceipt | null> {
  if (!live(tx, reference.receipt) || !acceptedReader()) return null;
  let source: AccountIdentitySource;
  try {
    source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'identity_epoch_unavailable') return null;
    throw error;
  }
  if (!matches(reference, source)) return null;
  const binding = await accepted(tx, source.input);
  if (!binding || binding.job.jobId !== reference.job.jobId || binding.job.epoch !== reference.job.epoch) return null;
  const prior = await receiver(tx, reference.receipt);
  if (prior) {
    const receipt = receiving(prior);
    return await verifyTechnicalSource(tx, reference, receipt) ? receipt : null;
  }
  const intent = technicalIntent(source.input.intent, reference.receipt);
  if (!intent || normalized(intent) !== normalized(source.input.intent) || source.roles.length > 8) return null;
  const producers = await producerInventory(tx, source);
  if (!producers) return null;
  // All rejection paths precede the first write/callback. SQL reserves the locked owner's
  // forthcoming fence, checked against the actual executor outbox by a deferred constraint.
  const row = (await tx.query(insert.sql, [
    routeOf(reference.receipt.account), reference.receipt.account, reference.receipt.kind, reference.receipt.receipt,
    json(intent), source.digest, source.partition, source.epoch, source.position.toString(), source.transactionId,
    reference.job.jobId, reference.job.epoch.toString(), binding.generation, binding.transactionId,
    source.workflowId, currentCommand(tx).transactionId, producers.domainGeneration,
  ])).rows[0];
  if (!row) throw accountIdentityUnavailable('technical receiver lost its locked native owner');
  wroteTechnical.add(tx);
  for (const account of producers.accounts) {
    await tx.query(
      `INSERT INTO access.agent_identity_technical_role
       (route,account_id,direction,receipt_id,role_account_id,roles,source_roles)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [routeOf(reference.receipt.account), reference.receipt.account, reference.receipt.kind, reference.receipt.receipt,
        account.accountId, account.roles, account.sourceRoles],
    );
  }
  registerCommandCallback(tx, async (transactionId) => {
    await tx.query("SELECT set_config('access.identity_technical_transaction',$1,true)", [transactionId]);
    if (transactionId !== row.receiving_transaction_id ||
      !(await verifyTechnicalSource(tx, reference, receiving(row))))
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
  const source = await readAccountIdentityTechnicalSource(tx, reference.receipt);
  const valid = !!row && !!source && matches(reference, source) &&
    row.accepted_job_id === reference.job.jobId && BigInt(row.accepted_job_epoch) === reference.job.epoch &&
    sameReceipt(receiving(row), native);
  // A false post-write observation must never let Source commit only its terminal half.
  if (!valid && wroteTechnical.has(tx))
    throw accountIdentityUnavailable('technical receiver mismatch after write');
  return valid;
}
