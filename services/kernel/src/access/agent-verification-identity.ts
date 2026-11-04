import { runIdentityTerminalCommand } from '../semantic/identity-terminal-closure-command.ts';
import {
  acceptTechnicalSource,
  verifyTechnicalSource,
  readAccountIdentityTechnicalSource,
} from './agent-verification-identity-retention.ts';
import type { IdentitySourceConsumerReference } from '../semantic/identity-source-consumer-custody.ts';
import { recordAgentIdentityWorkSource } from '../history/agent-identity-source.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
/** Access-owned source history. These helpers are internal to the native identity bridge. */
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { declareAgentIdentitySource, type AgentIdentitySourceKey } from '../history/agent-identity-source.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  noEffect,
  runCommand,
  currentCommandResources,
  currentCommandReceipt,
  DEFAULT_REQUEST_DEADLINE_MS,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accountAgentId } from '../semantic/agents.ts';
import type {
  IdentityNativeReceipt,
  IdentityAdmissionInput,
  IdentityIntent,
  IdentityJobRef,
  IdentityReceipt,
} from '../semantic/identity-epoch-contract.ts';
import { IdentityEpochStoreError } from '../semantic/identity-adapters/index.ts';
import insert from './agent-verification-identity-insert.sql';
import read from './agent-verification-identity-read.sql';
import {
  recoverMissingAccountIdentitySource,
  originalRecoveredAccountIdentitySource,
} from './agent-verification-identity-recovery.ts';

type AccountReceipt = Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
type Source = {
  account: string;
  accountKind: 'actor' | 'organization';
  catalogue: string;
  receipt: AccountReceipt;
  intent: IdentityIntent;
  requestedBy: string;
  decidedBy: string | null;
  requestId: string | null;
  pendingReceipt: string;
  commandReceipt?: { kind: string; key: string };
  undo?: Awaited<ReturnType<typeof publishedAccountIdentityUndo>>;
  decision?: Awaited<ReturnType<typeof readOriginalAgentIdentityDecision>>;
  verificationReceipt?: string;
  disposition?: 'released' | 'revoked';
  reason?: string | null;
};
export type AccountIdentitySource = Readonly<{
  input: Readonly<{ intent: IdentityIntent; receipt: AccountReceipt }>;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  digest: string;
  workflowId: string;
  roles: readonly import('../semantic/erasure-producer.ts').SemanticCopyRole[];
}>;
const nativeSources = new WeakMap<
  AccountIdentitySource,
  { time: string; key: string; deadline: number; undoOnly: boolean }
>();
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
const normalized = (value: unknown) => canonicalize(JSON.parse(json(value)))!;
const keyOf = (receipt: AccountReceipt) => JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
const digestOf = (input: IdentityAdmissionInput) =>
  createHash('sha256')
    .update(normalized([input.intent, input.receipt]))
    .digest('hex');
type OriginalIdentity = Readonly<{
  /** Identifies the actual serializer whose finite cut History owns. */
  writerKind: 'original' | 'recovery';
  key: AgentIdentitySourceKey;
  digest: string;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  workflowId: string;
  deliveryKey: string;
  handoff: Readonly<{
    partition: number;
    epoch: number;
    position: string;
    transactionId: string;
    eventType: string;
  }> | null;
  accounts: readonly import('../history/locator.ts').AccountReference[];
}>;
const originalIdentities = new WeakMap<CommandTransaction, OriginalIdentity>();

/** History's data-only declaration verifier. Only this original writer issues the binding;
 * a historical source read, source UUID or a copied query method cannot issue it. */
export function originalAccountIdentitySource(
  tx: CommandTransaction,
  key: AgentIdentitySourceKey,
  digest: string,
): OriginalIdentity {
  const command = currentCommand(tx);
  const original = originalIdentities.get(tx) ?? originalRecoveredAccountIdentitySource(tx);
  if (
    !original ||
    original.transactionId !== command.transactionId ||
    original.digest !== digest ||
    original.key.route !== key.route ||
    original.key.accountId !== key.accountId ||
    original.key.direction !== key.direction ||
    original.key.receiptId !== key.receiptId
  )
    throw new TypeError('Identity association requires its actual original source writer');
  return original;
}
export function accountIdentityUnavailable(detail: string): IdentityEpochStoreError {
  return new IdentityEpochStoreError('identity_epoch_unavailable', `Accounts source: ${detail}`);
}
function accountRoute(receipt: AccountReceipt): number {
  const route = routeOf(receipt.account);
  if (route === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(receipt.receipt))
    throw new TypeError('Accounts source requires exact native UUIDs');
  return route;
}

/** Record the immutable source and its SDK handoff in the ORIGINAL eventful account-home command. */
export async function recordAccountIdentitySource(tx: CommandTransaction, source: Source): Promise<void> {
  const command = currentCommand(tx);
  const route = accountRoute(source.receipt);
  if (command.partition !== partitionOf(route) || source.account !== source.receipt.account)
    throw new TypeError('Accounts source requires its original account-home transaction');
  if (source.pendingReceipt !== command.transactionId)
    throw new TypeError('Accounts source requires its original executor receipt');
  if (source.receipt.kind === 'account-agent.unverify' && source.receipt.receipt !== command.transactionId)
    throw new TypeError('Reversal source requires the original reversal transaction');
  if (
    source.receipt.kind === 'account-agent.verify' &&
    (!source.decision ||
      !originalDecisions.has(source.decision) ||
      source.decision.transaction_id !== source.receipt.receipt ||
      source.decision.account_id !== source.account ||
      source.decision.request_id !== source.requestId ||
      source.decision.catalogue_subject_id !== source.catalogue ||
      source.decision.requested_by !== source.requestedBy ||
      source.decision.decided_by !== source.decidedBy ||
      source.decision.account_kind !== source.accountKind)
  )
    throw new TypeError('Verification source requires actual released original Global decision custody');
  if (
    source.receipt.kind === 'account-agent.unverify' &&
    (!source.undo ||
      !publishedUndos.has(source.undo) ||
      source.intent.kind !== 'unmerge' ||
      source.undo.job.jobId !== source.intent.undoJob.jobId ||
      source.undo.job.epoch !== source.intent.undoJob.epoch ||
      source.undo.source.input.receipt.kind !== 'account-agent.verify' ||
      source.undo.source.input.receipt.account !== source.account ||
      source.undo.source.input.receipt.receipt !== source.verificationReceipt ||
      source.undo.source.input.intent.kind !== 'merge' ||
      source.undo.source.input.intent.survivor !== source.catalogue ||
      source.undo.source.input.intent.release !== source.intent.release)
  )
    throw new TypeError('Reversal source requires actual released published undo custody');
  const input = { intent: source.intent, receipt: source.receipt };
  if (
    (source.receipt.kind === 'account-agent.verify' &&
      (source.intent.kind !== 'merge' ||
        source.intent.redirected !== accountAgentId(source.account) ||
        source.intent.survivor !== source.catalogue ||
        !source.requestId ||
        !source.decidedBy)) ||
    (source.receipt.kind === 'account-agent.unverify' &&
      (source.intent.kind !== 'unmerge' ||
        source.intent.original !== accountAgentId(source.account) ||
        source.intent.verificationReceipt !== source.verificationReceipt))
  )
    throw new TypeError('Accounts source does not match its original decision');
  const undo = source.intent.kind === 'unmerge' ? source.intent.undoJob : null;
  const workflowId =
    source.receipt.kind === 'account-agent.verify'
      ? `accounts.agent-verification:${source.requestId}:${source.receipt.receipt}`
      : `accounts.agent-verification-reversal:${source.account}:${source.receipt.receipt}`;
  const commandReceipt =
    source.receipt.kind === 'account-agent.verify'
      ? { kind: 'access.agent-verification.pending', key: `${source.requestId}:pending` }
      : source.commandReceipt;
  if (!commandReceipt) throw new TypeError('Reversal source requires its original native command key');
  const actualReceipt = currentCommandReceipt(tx);
  if (
    actualReceipt.kind !== commandReceipt.kind ||
    actualReceipt.key !== commandReceipt.key ||
    actualReceipt.principal.kind !== 'account' ||
    actualReceipt.principal.id !== source.requestedBy
  )
    throw new TypeError('Accounts source requires its actual original native command receipt');
  const nativeReceiptKey = actualReceipt.storageKey;
  const inserted = await tx.query(insert.sql, [
    route,
    source.account,
    source.receipt.kind,
    source.receipt.receipt,
    accountAgentId(source.account),
    source.accountKind,
    source.catalogue,
    source.requestId,
    source.requestedBy,
    source.decidedBy,
    source.requestId ? 0 : null,
    source.requestId ? source.receipt.receipt : null,
    source.pendingReceipt,
    source.verificationReceipt ?? null,
    source.disposition ?? null,
    source.reason ?? null,
    source.intent.release,
    json(source.intent),
    digestOf(input),
    command.transactionId,
    undo?.jobId ?? null,
    undo?.epoch.toString() ?? null,
    keyOf(source.receipt),
    workflowId,
    command.partition,
    source.decision?.epoch ?? null,
    source.decision?.position ?? null,
    source.decision?.transaction_id ?? null,
    commandReceipt.kind,
    nativeReceiptKey,
    source.undo?.source.digest ?? null,
  ]);
  // A duplicate is possible only through the original native command receipt replay, which skips this body.
  // It must never rebind an existing historical source from a new command.
  if (inserted.rowCount !== 1) throw accountIdentityUnavailable(`conflicting original source ${keyOf(source.receipt)}`);
  const row = inserted.rows[0];
  const { ACCOUNT_ROLE_BITS: roles } = await import('../history/contracts.ts');
  const { unionHistoryScope } = await import('../history/record.ts');
  const ref = (accountId: string, mask: number) => ({ accountRoute: routeOf(accountId)!, accountId, roles: mask });
  const undoRoles =
    source.undo?.source.roles.map(({ account_id, role }) => {
      // This is the genuine released undo's closed Accounts vocabulary, not caller role text.
      const mask =
        role === 'subject'
          ? roles.subject
          : role === 'actor'
            ? roles.actor | roles.principal
            : role === 'editor'
              ? roles.reviewer
              : null;
      if (mask === null) throw new TypeError('Unknown original Accounts undo role');
      return ref(account_id, mask);
    }) ?? [];
  const key: AgentIdentitySourceKey = Object.freeze({
    route,
    accountId: source.account,
    direction: source.receipt.kind,
    receiptId: source.receipt.receipt,
  });
  const accounts = unionHistoryScope('command-receipt/v1', [
    ref(source.account, roles.subject),
    ref(source.requestedBy, roles.actor | roles.principal),
    ...(source.decidedBy ? [ref(source.decidedBy, roles.reviewer)] : []),
    ...(command.basis?.requestedBy ? [ref(command.basis.requestedBy, roles['acting-human'])] : []),
    ...undoRoles,
  ]).accounts;
  originalIdentities.set(
    tx,
    Object.freeze({
      writerKind: 'original',
      key,
      digest: row.intent_digest,
      partition: row.source_partition,
      epoch: row.source_epoch,
      position: BigInt(row.source_position),
      transactionId: row.source_transaction_id,
      workflowId,
      deliveryKey: keyOf(source.receipt),
      handoff: Object.freeze(
        source.decision
          ? {
              partition: 0,
              epoch: source.decision.epoch,
              position: source.decision.position,
              transactionId: source.decision.transaction_id,
              eventType: 'com.rezics.access.agent-verification.approved.v1',
            }
          : {
              partition: row.source_partition,
              epoch: row.source_epoch,
              position: String(row.source_position),
              transactionId: row.source_transaction_id,
              eventType: 'com.rezics.access.agent-verification.reversing.v1',
            },
      ),
      accounts: Object.freeze(accounts.map((account) => Object.freeze(account))),
    }),
  );
  await declareAgentIdentitySource(tx, key, digestOf(input));
  await recordAgentIdentityWorkSource(tx, source.receipt, source.decision?.custody_id ?? null);
}

/** Current native T and account terminal fence precede the immutable receipt lookup and any disclosure. */
export async function readAccountIdentitySource(
  tx: CommandTransaction,
  receipt: AccountReceipt,
  intent?: IdentityIntent,
  undoOnly = false,
): Promise<AccountIdentitySource> {
  const command = currentCommand(tx);
  const route = accountRoute(receipt);
  if (command.basis !== null || command.partition !== partitionOf(route))
    throw new TypeError('Accounts source verification requires its native platform home');
  const time = authoritativeTimeValue(command.time);
  const account = await tx.query<{ kind: 'actor' | 'organization'; state: string; authn_fenced: boolean }>(
    `SELECT kind,state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE`,
    [route, receipt.account],
  );
  const current = account.rows[0];
  // A committed terminal tombstone is authority only for the exact existing mechanical reversal.
  if (
    !current ||
    (receipt.kind === 'account-agent.verify' && !undoOnly && (current.state !== 'active' || current.authn_fenced))
  )
    throw accountIdentityUnavailable(`account fenced or absent ${receipt.account}`);
  const row = (await tx.query(read.sql, [route, receipt.account, receipt.kind, receipt.receipt])).rows[0];
  if ((!row || row.minimized) && undoOnly) {
    const technical = await readAccountIdentityTechnicalSource(tx, receipt);
    if (technical) {
      if (intent && normalized(intent) !== normalized(technical.input.intent))
        throw accountIdentityUnavailable(`mismatched accepted technical source ${keyOf(receipt)}`);
      // Technical custody never receives the new-admission capability in nativeSources.
      return technical;
    }
  }
  if (!row)
    throw accountIdentityUnavailable(
      `missing original ${keyOf(receipt)}; owner must recover native decision/pending or reversal custody`,
    );
  const stored = row.intent as IdentityIntent;
  const input = { intent: stored, receipt };
  if (
    row.source_partition !== command.partition ||
    row.source_epoch !== row.current_epoch ||
    BigInt(row.source_position) > BigInt(row.current_position) ||
    row.agent_id !== accountAgentId(receipt.account) ||
    row.account_kind !== current.kind ||
    row.delivery_key !== keyOf(receipt) ||
    row.release !== stored.release ||
    row.intent_digest !== digestOf(input) ||
    (intent && normalized(intent) !== normalized(stored)) ||
    (receipt.kind === 'account-agent.verify' &&
      (stored.kind !== 'merge' ||
        stored.redirected !== row.agent_id ||
        stored.survivor !== row.catalogue_id ||
        row.decision_route !== 0 ||
        row.decision_receipt_id !== receipt.receipt ||
        row.decision_transaction_id !== receipt.receipt ||
        !(row.decision_epoch > 0) ||
        !(BigInt(row.decision_position) > 0n) ||
        row.pending_receipt_id !== row.source_transaction_id)) ||
    (receipt.kind === 'account-agent.unverify' &&
      (stored.kind !== 'unmerge' ||
        stored.original !== row.agent_id ||
        stored.verificationReceipt !== row.verification_receipt_id ||
        row.source_transaction_id !== receipt.receipt ||
        stored.undoJob.jobId !== row.undo_job_id ||
        stored.undoJob.epoch.toString() !== String(row.undo_job_epoch)))
  )
    throw accountIdentityUnavailable(`moved or mismatched native source ${keyOf(receipt)}`);
  // pg JSON carries decimal bigint text; reconstruct only this closed native field.
  const nativeIntent: IdentityIntent =
    stored.kind === 'unmerge'
      ? { ...stored, undoJob: { jobId: stored.undoJob.jobId, epoch: BigInt(stored.undoJob.epoch) } }
      : stored;
  const source = Object.freeze({
    input: Object.freeze({ intent: Object.freeze(nativeIntent), receipt: Object.freeze({ ...receipt }) }),
    partition: command.partition,
    epoch: row.source_epoch,
    position: BigInt(row.source_position),
    transactionId: row.source_transaction_id,
    digest: row.intent_digest,
    workflowId: row.workflow_id,
    roles: Object.freeze(
      [
        { account_id: receipt.account, role: 'subject' },
        ...(row.requested_by ? [{ account_id: row.requested_by as string, role: 'actor' }] : []),
        ...(row.decided_by ? [{ account_id: row.decided_by as string, role: 'editor' }] : []),
      ].map((role) => Object.freeze(role)),
    ),
  });
  nativeSources.set(source, { time, key: keyOf(receipt), deadline: currentCommandResources(tx).deadline, undoOnly });
  return source;
}

/** Opaque source custody from a released native read; JSON or a raw CommandAuthorization cannot mint it. */
export function assertAccountIdentitySource(
  source: AccountIdentitySource,
  receipt: AccountReceipt,
  intent?: IdentityIntent,
): void {
  const proof = nativeSources.get(source);
  if (
    !proof ||
    proof.undoOnly ||
    Date.now() >= proof.deadline ||
    proof.key !== keyOf(receipt) ||
    source.digest !== digestOf(source.input) ||
    (intent && normalized(source.input.intent) !== normalized(intent))
  )
    throw new TypeError('Accounts identity requires actual released native source custody');
}

export async function loadAccountIdentitySource(pool: Pool, receipt: AccountReceipt): Promise<AccountIdentitySource> {
  const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  return withRequestDeadline(deadline, async () => {
    const load = async () =>
      (
        await runIdentityTerminalCommand(
          pool,
          { partition: partitionOf(accountRoute(receipt)), deadline },
          async (tx) => noEffect(await readAccountIdentitySource(tx, receipt)),
        )
      ).value;
    try {
      return await load();
    } catch (error) {
      if (!(await recoverMissingAccountIdentitySource(pool, receipt, error, deadline))) throw error;
      return load();
    }
  });
}

/** Typed adapter for the delivered coordinator ABI. Absence is durable retryable unavailability. */
async function coordinator(): Promise<{
  resumeIdentityEpochJob: import('../semantic/identity-epoch-contract.ts').ResumeIdentityEpochJob;
  waitIdentityEpochPublished: import('../semantic/identity-epoch-contract.ts').WaitIdentityEpochPublished;
}> {
  const location = new URL('../semantic/identity-epoch-coordinator.ts', import.meta.url);
  // A variable module URL keeps the adapter buildable during the independent producer cutover.
  // Only the exact delivered module/export names are accepted; no callback or fallback implementation.
  let implementation: Record<string, unknown>;
  try {
    implementation = await import(location.href);
  } catch (error) {
    if (error instanceof Error && /Cannot find module|ModuleNotFound|module not found/i.test(error.message))
      throw accountIdentityUnavailable('semantic/identity-epoch-coordinator.ts is not integrated');
    throw error;
  }
  if (
    typeof implementation.resumeIdentityEpochJob !== 'function' ||
    typeof implementation.waitIdentityEpochPublished !== 'function'
  )
    throw accountIdentityUnavailable('native coordinator resume/wait exports are not integrated');
  return implementation as Awaited<ReturnType<typeof coordinator>>;
}

/** One bounded delivery/probe invocation. The original DBOS workflow owns durable sleeps/redrive. */
export function deliverAccountIdentity(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef> {
  return withRequestDeadline(Math.min(deadlineFor(5000), Date.now() + 5000), () =>
    deliverAccountIdentityBounded(pool, receipt),
  );
}
async function deliverAccountIdentityBounded(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef> {
  const source = await loadAccountIdentitySource(pool, receipt);
  const native = await coordinator();
  const { identityEpochStore, identityJobPartition } = await import('../semantic/identity-adapters/index.ts');
  const job = await identityEpochStore.prepareAdmission(pool, {}, source.input);
  await native.resumeIdentityEpochJob(pool, job);
  await native.waitIdentityEpochPublished(pool, job);
  // Completion is independently read from actual native custody, never inferred from adapter return.
  const binding = await identityEpochStore.bindReceipt(pool, {}, source.input);
  const published = (
    await runIdentityTerminalCommand(pool, { partition: identityJobPartition(job) }, async (tx) =>
      noEffect(await identityEpochStore.findJob(tx, receipt, binding)),
    )
  ).value;
  if (
    !published ||
    published.ref.jobId !== job.jobId ||
    published.ref.epoch !== job.epoch ||
    published.state !== 'published' ||
    published.mapping?.state !== 'complete' ||
    published.participants['search-canonical-index']?.state !== 'complete' ||
    published.participants['library-private-follow-counts']?.state !== 'complete'
  )
    throw accountIdentityUnavailable(`publication pending ${keyOf(receipt)}`);
  return job;
}

/** Reversal may name only the actual prior published verification job, after released source verification. */
export async function publishedAccountIdentityUndo(
  pool: Pool,
  account: string,
  verificationReceipt: string,
): Promise<{
  job: IdentityJobRef;
  source: AccountIdentitySource;
}> {
  const receipt: AccountReceipt = { kind: 'account-agent.verify', account, receipt: verificationReceipt };
  const { readAccountIdentityUndo } = await import('../semantic/identity-adapters/identity-epoch-binding.ts');
  const existing = await readAccountIdentityUndo(pool, receipt);
  const { identityEpochStore, identityJobPartition } = await import('../semantic/identity-adapters/index.ts');
  const saved = (
    await runIdentityTerminalCommand(pool, { partition: identityJobPartition(existing.job) }, async (tx) =>
      noEffect(await identityEpochStore.readJob(tx, existing.job)),
    )
  ).value;
  const source = existing.source;
  if (
    !saved ||
    saved.state !== 'published' ||
    saved.mapping?.state !== 'complete' ||
    saved.participants['search-canonical-index']?.state !== 'complete' ||
    saved.participants['library-private-follow-counts']?.state !== 'complete'
  )
    throw accountIdentityUnavailable(`prior undo is unpublished ${keyOf(receipt)}`);
  const undo = Object.freeze({ job: Object.freeze(saved.ref), source });
  publishedUndos.add(undo);
  return undo;
}

/** Actual Global decision locator, resolved before the account home is acquired. */
export async function readOriginalAgentIdentityDecision(pool: Pool, requestId: string, receiptId: string) {
  const { withReadTransaction } = await import('../semantic/read.ts');
  const row = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{
          request_id: string;
          account_id: string;
          account_kind: 'actor' | 'organization';
          catalogue_subject_id: string;
          requested_by: string;
          decided_by: string;
          epoch: number;
          position: string;
          transaction_id: string;
          native_receipt_key: string;
          request_digest: string;
          custody_id: string | null;
        }>(
          `SELECT r.request_id,r.account_id,r.account_kind,r.catalogue_subject_id,r.requested_by,r.decided_by,
        b.epoch,b.position::text,b.transaction_id,c.idempotency_key AS native_receipt_key,
        encode(c.request_digest,'hex') AS request_digest,w.custody_id
      FROM access.agent_verification_request r
      JOIN editorial.write_basis b ON b.partition_no=0 AND b.transaction_id=r.decision_receipt_id
        AND b.principal_kind='account' AND b.principal_id=r.decided_by
      JOIN core.receipt c ON c.partition_no=0 AND c.transaction_id=b.transaction_id
        AND c.principal_kind='account' AND c.principal_id=r.decided_by
        AND c.command_kind='access.agent-verification.approve' AND c.epoch=b.epoch AND c.position=b.position
      LEFT JOIN core.agent_identity_work w ON w.workflow_id=
        'accounts.agent-verification:' || r.request_id::text || ':' || r.decision_receipt_id::text
      JOIN core.partition p ON p.partition_no=0 AND p.write_state='active'
        AND p.epoch=b.epoch AND p.position>=b.position
      WHERE r.route=0 AND r.request_id=$1 AND r.decision_receipt_id=$2
        AND r.state IN ('approving','approved')`,
          [requestId, receiptId],
        )
      ).rows[0],
  );
  if (!row) throw accountIdentityUnavailable(`missing original Global decision ${requestId}:${receiptId}`);
  const decision = Object.freeze(row);
  originalDecisions.add(decision);
  return decision;
}
export type OriginalAgentIdentityDecision = Awaited<ReturnType<typeof readOriginalAgentIdentityDecision>>;
export function assertOriginalAgentIdentityDecision(decision: OriginalAgentIdentityDecision): void {
  if (!originalDecisions.has(decision)) throw new TypeError('Original Global decision custody required');
}
const originalDecisions = new WeakSet<object>();
const publishedUndos = new WeakSet<object>();

/** Effects-free publication probe; retained history and unrelated jobs are never scanned. */
export function probeAccountIdentityPublication(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef> {
  return withRequestDeadline(Math.min(deadlineFor(5000), Date.now() + 5000), () =>
    probeAccountIdentityPublicationBounded(pool, receipt),
  );
}
async function probeAccountIdentityPublicationBounded(pool: Pool, receipt: AccountReceipt): Promise<IdentityJobRef> {
  const source = await loadAccountIdentitySource(pool, receipt);
  const { lookupIdentityBinding } = await import('../semantic/identity-adapters/identity-epoch-binding.ts');
  const { identityEpochStore, identityJobPartition } = await import('../semantic/identity-adapters/index.ts');
  const binding = await lookupIdentityBinding(pool, {}, source.input);
  if (!binding) throw accountIdentityUnavailable(`missing published binding ${keyOf(receipt)}`);
  const saved = (
    await runIdentityTerminalCommand(pool, { partition: identityJobPartition(binding.job) }, async (tx) =>
      noEffect(await identityEpochStore.findJob(tx, receipt, binding)),
    )
  ).value;
  if (
    !saved ||
    saved.state !== 'published' ||
    saved.mapping?.state !== 'complete' ||
    saved.participants['search-canonical-index']?.state !== 'complete' ||
    saved.participants['library-private-follow-counts']?.state !== 'complete'
  )
    throw accountIdentityUnavailable(`publication pending ${keyOf(receipt)}`);
  return saved.ref;
}

/** Same-home accepted technical custody; never admission, erasure completion or permission. */
export async function acceptAccountIdentityTechnicalSource(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
): Promise<IdentityNativeReceipt | null> {
  return acceptTechnicalSource(tx, reference);
}

/** Re-lock the durable receiver in the enclosing source-home command. */
export async function verifyAccountIdentityTechnicalSource(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  receiving: IdentityNativeReceipt,
): Promise<boolean> {
  return verifyTechnicalSource(tx, reference, receiving);
}

export {
  readAccountIdentityReversalSettlement,
  verifyAccountIdentityReversalSettlement,
  type AccountIdentityReversalSettlement,
} from './agent-verification-identity-reversal.ts';
