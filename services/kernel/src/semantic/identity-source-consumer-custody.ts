import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type {
  IdentityFrontier,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityReceipt,
  NativeStepWork,
} from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { LibraryScopeEffectSeal } from '../library/identity-scope-effects.ts';
import { readLibraryScopeEffectsPage, verifyLibraryScopeEffectsSeal } from '../library/identity-scope-effects.ts';
import type { LibraryExpectedEffectAfter } from '../library/identity-scope-effects.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { instrumentNativeCollectionWork } from '../library/collection-source-work.ts';
import { readIdentityPrearmCustodyPage, verifyIdentityPrearmCustodyCut } from './identity-epoch-prearm-custody.ts';
import { identityScopeAddress } from './identity-scoped-observations.ts';
import { readIdentityReceivingSelection, reconcileIdentityReceivingEffect } from './identity-receiving-effects.ts';
import type { IdentityReceivingSelection, IdentityReceivingRecord } from './identity-receiving-effects-types.ts';
import { readAccountIdentitySource, type AccountIdentitySource } from '../access/agent-verification-identity.ts';
import type { AccountIdentityReversalSettlement } from '../access/agent-verification-identity-reversal.ts';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  registerCommandCallback,
  runCommand,
} from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { bindSemanticProducerRoles, recordSemanticSourceCommit } from './erasure-producer.ts';
import { identityBindingData, lookupIdentityBinding, readAccountIdentityUndo } from './identity-epoch-binding.ts';
import {
  identityEpochStore,
  identityJobPartition,
  identityReceiptKey,
  IdentityEpochStoreError,
  serializeIdentityValue,
} from './identity-epoch-store.ts';
import { SEMANTIC_ERASURE_PROGRESS } from './account-erasure.ts';
import claim from './identity-source-consumer-custody-claim.sql';
import job from './identity-source-consumer-custody-job.sql';
import insert from './identity-source-consumer-custody-insert.sql';
import select from './identity-source-consumer-custody-select.sql';
import progressSQL from './identity-source-consumer-custody-progress.sql';
import appendSQL from './identity-source-consumer-custody-append.sql';
import historySQL from './identity-source-consumer-custody-history.sql';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AgentIdentityRetirementStage } from '../history/agent-identity-retirement.ts';
import type { AgentIdentitySDKReceivingBinding } from '../history/agent-identity-sdk-fence.ts';
import {
  lockSdkWorkflowWriterState,
  SDK_TRANSACTION_FENCE_COST,
  type SdkWriterState,
} from '../work/sdk-retirement-fence.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
import { identitySourceConsumerDirectoryPlan } from './identity-source-maintenance-config.ts';
import {
  currentIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
} from './identity-source-consumer-maintenance.ts';

export type IdentitySourceConsumerReference = Readonly<{
  receipt: Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
  job: IdentityJobRef;
  source: IdentityNativeReceipt;
  sourceDigest: string;
  barrier: HistoryBarrier;
  /** subject is the original source key's account, distinct from requester/decider. */
  erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
  [identitySourceConsumerCustody]: true;
}>;

/** Required additive owner exchange, not a caller proof or an installed adapter. Native
 * implementations must resolve these generations from the original accepted input. */
export type IdentitySourceConsumerGeneration = Readonly<{
  replayGeneration: string;
  undoGeneration: string;
  restoreGeneration: string;
}>;
export type IdentitySourceConsumerWork = IdentitySourceConsumerGeneration & Readonly<{ allowance: NativeStepWork }>;
export type IdentitySourceConsumerContext = Readonly<{
  deadline: number;
  identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerDisposition = 'discharged' | 'transferred';
export type IdentitySourceScopeConsumerWork = Readonly<{
  allowance: WorkAllowance;
  /** Native owners provide proved SQL bounds. Unknown SQL must be refused before dispatch. */
  footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
}>;

/** Original modules supply these methods. There is deliberately no setter/default ACK.
 * See the owning contract for the native locks, writer obligations and accounting required. */
type BindingConsumerOwner = {
  readIdentitySourceConsumerWork(
    pool: Pool,
    reference: IdentitySourceConsumerReference,
    context: IdentitySourceConsumerContext,
  ): Promise<IdentitySourceConsumerWork | null>;
  lockIdentitySourceConsumerCut(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    expected: IdentitySourceConsumerGeneration,
    reversal?: AccountIdentityReversalSettlement,
  ): Promise<IdentitySourceConsumerDisposition | null>;
  verifyIdentitySourceConsumerCut(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    expected: IdentitySourceConsumerGeneration,
    disposition: IdentitySourceConsumerDisposition,
    reversal?: AccountIdentityReversalSettlement,
  ): Promise<boolean>;
};
type ScopedConsumerOwner = {
  readIdentityScopeConsumerWork(
    pool: Pool,
    ticket: IdentityPrearmTicketData,
    context: IdentitySourceConsumerContext,
  ): Promise<IdentitySourceScopeConsumerWork | null>;
  retainIdentityScopeConsumerFence(
    tx: CommandTransaction,
    ticket: IdentityPrearmTicketData,
    seal: LibraryScopeEffectSeal,
  ): Promise<IdentityNativeReceipt | null>;
};
type TechnicalConsumerOwner = {
  readAccountIdentityReversalSettlement(
    pool: Pool,
    reference: IdentitySourceConsumerReference,
    context: IdentitySourceConsumerContext,
  ): Promise<AccountIdentityReversalSettlement | null>;
  acceptAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
  ): Promise<IdentityNativeReceipt | null>;
  verifyAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    receiving: IdentityNativeReceipt,
  ): Promise<boolean>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const json = (value: unknown): string => canonicalize(JSON.parse(serializeIdentityValue(value)))!;
const locator = Symbol('identity-source-consumer-custody-locator');
type LocalProof = IdentitySourceConsumerCustody &
  Readonly<{
    [locator]: Readonly<{
      source: IdentityNativeReceipt;
      reversal: AccountIdentityReversalSettlement | null;
    }>;
  }>;

function valid(reference: IdentitySourceConsumerReference): boolean {
  const { receipt, source, barrier } = reference;
  const accountRoute = routeOf(receipt.account);
  return (
    (receipt.kind === 'account-agent.verify' || receipt.kind === 'account-agent.unverify') &&
    uuid.test(receipt.account) &&
    uuid.test(receipt.receipt) &&
    accountRoute !== null &&
    source.partition === partitionOf(accountRoute) &&
    uuid.test(source.transactionId) &&
    Number.isSafeInteger(source.epoch) &&
    source.epoch > 0 &&
    source.epoch <= 2147483647 &&
    typeof source.position === 'bigint' &&
    source.position > 0n &&
    source.position <= 9223372036854775807n &&
    digest.test(reference.sourceDigest) &&
    uuid.test(reference.job.jobId) &&
    routeOf(reference.job.jobId) !== null &&
    typeof reference.job.epoch === 'bigint' &&
    reference.job.epoch > 0n &&
    reference.job.epoch <= 9223372036854775807n &&
    uuid.test(barrier.accountId) &&
    routeOf(barrier.accountId) === barrier.accountRoute &&
    Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 &&
    barrier.version <= 2147483647 &&
    Number.isFinite(Date.parse(barrier.at)) &&
    ['subject', 'requester', 'decider'].includes(reference.erasedRole) &&
    (reference.erasedRole !== 'subject' || barrier.accountId === receipt.account)
  );
}

function sameSource(reference: IdentitySourceConsumerReference, source: AccountIdentitySource): boolean {
  const role = { subject: 'subject', requester: 'actor', decider: 'editor' }[reference.erasedRole];
  return (
    json(source.input.receipt) === json(reference.receipt) &&
    source.partition === reference.source.partition &&
    source.epoch === reference.source.epoch &&
    source.position === reference.source.position &&
    source.transactionId === reference.source.transactionId &&
    source.digest === reference.sourceDigest &&
    source.roles.some((entry) => entry.account_id === reference.barrier.accountId && entry.role === role)
  );
}

/** Resolve only already accepted native inputs. Verification uses the undo-only Accounts port
 * after T; reversal resolves ITS OWN accepted claim, never intent.undoJob. Each command releases
 * its home before the next probe. No admission is performed to repair a missing hint.
 */
async function original(pool: Pool, reference: IdentitySourceConsumerReference, deadline: number) {
  let source: AccountIdentitySource;
  if (reference.receipt.kind === 'account-agent.verify') {
    const undo = await readAccountIdentityUndo(pool, reference.receipt);
    if (undo.job.jobId !== reference.job.jobId || undo.job.epoch !== reference.job.epoch) return null;
    source = undo.source;
  } else {
    source = (
      await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
        noEffect(await readAccountIdentitySource(tx, reference.receipt)),
      )
    ).value;
    if (!sameSource(reference, source)) return null;
    const binding = await lookupIdentityBinding(pool, { deadline }, source.input);
    if (!binding) return null;
    const data = identityBindingData(binding);
    if (
      data.state !== 'accepted' ||
      data.key !== identityReceiptKey(reference.receipt) ||
      data.digest !== reference.sourceDigest ||
      data.job.jobId !== reference.job.jobId ||
      data.job.epoch !== reference.job.epoch ||
      data.home !== identityJobPartition(reference.job)
    )
      return null;
  }
  return sameSource(reference, source) ? source : null;
}

async function acceptedClaim(tx: CommandTransaction, reference: IdentitySourceConsumerReference) {
  if (currentCommand(tx).partition !== reference.source.partition) return null;
  const row = (
    await tx.query<{
      generation: string;
      scope_digest: string;
      binding_transaction_id: string;
      job_home: number;
      sources: unknown;
      receipt: unknown;
      intent: unknown;
    }>(claim.sql, [
      reference.source.partition,
      identityReceiptKey(reference.receipt),
      reference.sourceDigest,
      reference.job.jobId,
      reference.job.epoch.toString(),
    ])
  ).rows[0];
  return row && row.job_home === identityJobPartition(reference.job) && json(row.receipt) === json(reference.receipt)
    ? row
    : null;
}

/** Publication is only a prerequisite. Reconcile ALL three fixed native receipts through
 * their real producer; a saved complete flag or coordinator return cannot replace this step.
 */
async function published(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  scope: string,
  source: AccountIdentitySource,
  deadline: number,
): Promise<boolean> {
  const home = identityJobPartition(reference.job);
  const read = () =>
    runCommand(pool, { partition: home, deadline }, async (tx) => {
      const saved = await identityEpochStore.readJob(tx, reference.job);
      const native = (
        await tx.query<{ scope_digest: string }>(job.sql, [home, reference.job.jobId, reference.job.epoch.toString()])
      ).rows[0];
      return noEffect(
        saved &&
          native?.scope_digest === scope &&
          json(saved.receipt) === json(reference.receipt) &&
          json(saved.intent) === json(source.input.intent)
          ? saved
          : null,
      );
    });
  const saved = (await read()).value;
  if (!saved || saved.state !== 'published') return false;
  for (const [step, progress] of [
    ['mapping', saved.mapping],
    ['search-canonical-index', saved.participants['search-canonical-index']],
    ['library-private-follow-counts', saved.participants['library-private-follow-counts']],
  ] as const) {
    if (
      !progress ||
      progress.state !== 'complete' ||
      progress.job.jobId !== reference.job.jobId ||
      progress.job.epoch !== reference.job.epoch ||
      progress.receipt.step !== step ||
      progress.receipt.job.jobId !== reference.job.jobId ||
      progress.receipt.job.epoch !== reference.job.epoch
    )
      return false;
    const reconciled = await identityEpochStore.reconcileStepReceipt(pool, progress.receipt);
    if (reconciled.state !== 'complete' || json(reconciled) !== json(progress)) return false;
  }
  return (await read()).value?.state === 'published';
}

/** Prepare retained native custody, then advance one exhaustive consumer-cut step. Missing
 * native fences or technical receiving authority leave the original bytes retained. */
export async function readIdentitySourceConsumerCustody(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext,
): Promise<IdentitySourceConsumerCustody | null> {
  const funded = context.identityConsumerWork;
  if (!funded || !isLiveIdentitySourceConsumerMaintenance(pool, funded, context.deadline)) return null;
  if (!valid(reference) || !Number.isFinite(context.deadline) || context.deadline <= Date.now()) return null;
  // Fixed Source admission, original-source/claim/job and participant probes, progress,
  // terminal and cleanup commands are reserved before this callback's first checkout.
  if (
    !reserveIdentitySourceConsumerNativeWork(pool, funded, {
      rows: 32,
      points: 32,
      statements: 29,
      bytes: 32768,
      engineRequests: 0,
    })
  )
    return null;
  reference = Object.freeze({
    ...reference,
    receipt: Object.freeze({ ...reference.receipt }),
    job: Object.freeze({ ...reference.job }),
    source: Object.freeze({ ...reference.source }),
    barrier: Object.freeze({ ...reference.barrier }),
  });
  return withRequestDeadline(context.deadline, async () => {
    try {
      // A genuine transferred source remains readable after Accounts minimizes its original
      // bytes. Resolve terminal native custody before asking the old-source/undo reader.
      const committedRow = (
        await runCommand(pool, { partition: reference.source.partition, deadline: context.deadline }, async (tx) => {
          const retained = (await tx.query<Retained>(select.sql, referenceValues(reference))).rows[0];
          if (!retained) return noEffect(null);
          const row = await latest(tx, retained);
          return noEffect(row && terminal(row.state) ? row : null);
        })
      ).value;
      if (committedRow) return await verifiedTerminal(pool, reference, committedRow, context.deadline, funded);
      const source = await original(pool, reference, context.deadline);
      if (!source) return null;
      const binding = (
        await runCommand(pool, { partition: reference.source.partition, deadline: context.deadline }, async (tx) =>
          noEffect(await acceptedClaim(tx, reference)),
        )
      ).value;
      if (!binding || json(binding.intent) !== json(source.input.intent)) return null;
      if (!(await published(pool, reference, binding.scope_digest, source, context.deadline))) return null;

      // Every foreign Source/receiver/control checkout has been released. Re-resolve the native
      // claim, source and current owner in this single original-home command. Retention alone
      // grants no cleanup, and does not assert that released foreign observations stay current.
      const retained = await runCommand(
        pool,
        { partition: reference.source.partition, deadline: context.deadline },
        async (tx) => {
          const current = await acceptedClaim(tx, reference);
          if (
            !current ||
            current.generation !== binding.generation ||
            current.binding_transaction_id !== binding.binding_transaction_id ||
            current.scope_digest !== binding.scope_digest ||
            json(current.sources) !== json(binding.sources)
          )
            return noEffect(null);
          const live = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
          const owner = await readPartition(tx, reference.source.partition);
          if (!sameSource(reference, live) || !owner || owner.writeState !== 'active') return noEffect(null);
          const values = referenceValues(reference);
          const existing = (await tx.query<Retained>(select.sql, values)).rows[0];
          if (existing) return noEffect(existing);
          bindSemanticProducerRoles(tx, live.roles);
          registerCommandCallback(tx, async (transactionId) => {
            await recordSemanticSourceCommit(tx, transactionId);
            await tx.query(insert.sql, [
              ...values,
              current.generation,
              current.binding_transaction_id,
              current.scope_digest,
              owner.epoch,
              transactionId,
            ]);
          });
          return {
            value: null,
            events: [
              {
                type: SEMANTIC_ERASURE_PROGRESS,
                subject: reference.barrier.accountId,
                data: { accountId: reference.barrier.accountId },
              },
            ],
          };
        },
      );
      // A newly inserted retained receipt is deliberately not used before its native commit.
      // No foreign home is held while the bounded consumer continuation runs.
      const saved =
        retained.value ??
        (
          await runCommand(pool, { partition: reference.source.partition, deadline: context.deadline }, async (tx) =>
            noEffect((await tx.query<Retained>(select.sql, referenceValues(reference))).rows[0] ?? null),
          )
        ).value;
      return saved ? await advanceConsumers(pool, reference, saved, source.roles, context.deadline, funded) : null;
    } catch (error) {
      if (
        error instanceof IdentityEpochStoreError &&
        ['identity_epoch_unavailable', 'identity_effect_stale', 'identity_step_receipt_invalid'].includes(error.code)
      )
        return null;
      throw error;
    }
  });
}

function referenceValues(reference: IdentitySourceConsumerReference): unknown[] {
  const { source, receipt, job, barrier } = reference;
  return [
    source.partition,
    identityReceiptKey(receipt),
    reference.sourceDigest,
    source.epoch,
    source.position.toString(),
    source.transactionId,
    job.jobId,
    job.epoch.toString(),
    barrier.accountId,
    barrier.accountRoute,
    barrier.version,
    barrier.at,
    reference.erasedRole,
  ];
}

type Retained = {
  erasure_key: string;
  binding_generation: string;
  transaction_id: string;
  owner_epoch: number;
  position: string;
};
type Progress = {
  sequence: string;
  state: 'scope' | 'directory' | IdentitySourceConsumerDisposition;
  directory_after: IdentityFrontier | null;
  ticket_key: string | null;
  effect_after: LibraryExpectedEffectAfter | null;
  seal_digest: string | null;
  replay_generation: string;
  undo_generation: string;
  restore_generation: string;
  transaction_id: string;
  owner_epoch: number;
  position: string;
  native_current: boolean;
  receiving_partition: number | null;
  receiving_epoch: number | null;
  receiving_position: string | null;
  receiving_transaction_id: string | null;
};
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const terminal = (state: Progress['state']): state is IdentitySourceConsumerDisposition =>
  state === 'discharged' || state === 'transferred';
const generations = (row: Progress): IdentitySourceConsumerGeneration => ({
  replayGeneration: row.replay_generation,
  undoGeneration: row.undo_generation,
  restoreGeneration: row.restore_generation,
});
const sameGeneration = (a: IdentitySourceConsumerGeneration, b: IdentitySourceConsumerGeneration) =>
  a.replayGeneration === b.replayGeneration &&
  a.undoGeneration === b.undoGeneration &&
  a.restoreGeneration === b.restoreGeneration;
const validGeneration = (value: IdentitySourceConsumerGeneration) =>
  [value.replayGeneration, value.undoGeneration, value.restoreGeneration].every(
    (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n,
  );
function boundedFrontier(value: IdentityFrontier): boolean {
  return (
    Number.isSafeInteger(value.segment) &&
    value.segment >= 0 &&
    value.after.length <= 8 &&
    value.after.every(
      (v) => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v)),
    ) &&
    Buffer.byteLength(json(value)) <= 2048
  );
}
function nativeProof(
  reference: IdentitySourceConsumerReference,
  row: Progress,
  reversal: AccountIdentityReversalSettlement | null = null,
): IdentitySourceConsumerCustody {
  return Object.freeze({
    [locator]: Object.freeze({
      source: Object.freeze({
        partition: reference.source.partition,
        epoch: row.owner_epoch,
        position: BigInt(row.position),
        transactionId: row.transaction_id,
      }),
      reversal,
    }),
  }) as LocalProof;
}
async function verifiedTerminal(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  row: Progress,
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  let reversal: AccountIdentityReversalSettlement | null = null;
  if (row.state === 'discharged') {
    if (reference.erasedRole !== 'subject') return null;
    reversal =
      (await (
        await owners()
      ).technical.readAccountIdentityReversalSettlement?.(pool, reference, {
        deadline,
        identityConsumerWork,
      })) ?? null;
    if (!reversal) return null;
  }
  const proof = nativeProof(reference, row, reversal);
  return (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
      noEffect((await verifyIdentitySourceConsumerCustody(tx, reference, proof)) ? proof : null),
    )
  ).value;
}
async function owners() {
  // Only exact original modules are consulted. Missing additive exports fail pending, with
  // their complete native requirements published in the owner contract. No replacement producer.
  const binding = (await import('./identity-epoch-binding.ts')) as Partial<BindingConsumerOwner>;
  const scope = (await import('./identity-scoped-observations.ts')) as Partial<ScopedConsumerOwner>;
  const technical = (await import('../access/agent-verification-identity.ts')) as Partial<TechnicalConsumerOwner>;
  return { binding, scope, technical };
}
async function latest(tx: CommandTransaction, retained: Retained): Promise<Progress | null> {
  const row =
    (await tx.query<Progress>(progressSQL.sql, [currentCommand(tx).partition, retained.erasure_key])).rows[0] ?? null;
  if (row && !row.native_current)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Consumer continuation lost current native provenance',
    );
  return row;
}

/** Native and Library accounting remain separate; no conversion between units.
 * The binding owner's planning ceiling bounds both children; their ReadWork counters
 * charge the same live Source frame before dispatch, without another allocation. */
class DirectoryWork {
  private readonly remaining: { -readonly [K in keyof NativeStepWork]: number };
  constructor(allowance: NativeStepWork) {
    this.remaining = { ...identitySourceConsumerDirectoryPlan(allowance).envelope };
    if (Object.values(this.remaining).some((v) => !Number.isSafeInteger(v) || v < 0))
      throw new TypeError('Invalid admitted consumer work');
  }
  reserve(): NativeStepWork | null {
    // The read's opaque cut saves this allowance for its independent verify. Reserve BOTH
    // calls before either dispatch; failed/unavailable work is never refunded for reuse.
    const allowance = identitySourceConsumerDirectoryPlan(this.remaining).child;
    if (allowance.rows < 1 || allowance.points < 1 || allowance.statements < 1) return null;
    for (const k of Object.keys(this.remaining) as (keyof NativeStepWork)[]) this.remaining[k] -= allowance[k] * 2;
    return allowance;
  }
}
function matchesReceiving(
  ticket: IdentityPrearmTicketData,
  selection: IdentityReceivingSelection,
  record: IdentityReceivingRecord,
): boolean {
  if (ticket.scope.source.kind !== 'library' || ticket.scope.source.identity.scope === 'public_output') return false;
  const identity = ticket.scope.source.identity;
  const { effectKey: _effect, receivingEpoch: _epoch, ...source } = identity;
  const { effectKey: _recordEffect, receivingEpoch: _recordEpoch, ...received } = record.source.native.identity;
  return (
    json(selection.job) === json(ticket.locator.job) &&
    json(record.job) === json(selection.job) &&
    selection.sourceId === identity.collectionId &&
    selection.owner === identity.collectionId &&
    selection.scope === ticket.scope.scopeId &&
    record.original === selection.original &&
    record.effectKey === selection.effectKey &&
    record.owner === selection.owner &&
    record.source.id === selection.sourceId &&
    record.source.scope === selection.scope &&
    record.source.disposition === selection.disposition &&
    record.step === 'library-private-follow-counts' &&
    record.version === 1 &&
    record.source.incarnation === identity.incarnation &&
    record.source.generation === identity.generation &&
    json(source) === json(received) &&
    !!selection.capture &&
    json(selection.capture.identity) === json(record.source.native.identity) &&
    selection.capture.frontier.captureId === record.source.native.captureId &&
    record.source.native.captureId === ticket.captureId &&
    record.applied !== null
  );
}

type Next = Readonly<{
  state: Progress['state'];
  directory: IdentityFrontier | null;
  ticket: string | null;
  after: LibraryExpectedEffectAfter | null;
  seal: LibraryScopeEffectSeal | null;
  fence: IdentityNativeReceipt | null;
}>;
async function checkpoint(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  previous: Progress | null,
  generation: IdentitySourceConsumerGeneration,
  next: Next,
  roles: AccountIdentitySource['roles'],
  deadline: number,
): Promise<boolean> {
  if (
    (next.directory && !boundedFrontier(next.directory)) ||
    (next.directory?.after.length ?? 0) + (next.directory ? 1 : 0) + (next.after ? 2 : 0) > 8 ||
    Buffer.byteLength(json([next.directory, next.after])) > 2048
  )
    return false;
  return (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) => {
      const claim = await acceptedClaim(tx, reference);
      if (!claim || claim.generation !== retained.binding_generation) return noEffect(false);
      const current = await latest(tx, retained);
      if ((current?.sequence ?? null) !== (previous?.sequence ?? null) || (current && terminal(current.state)))
        return noEffect(false);
      const owner = await readPartition(tx, reference.source.partition);
      const source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
      if (!owner || owner.writeState !== 'active' || !sameSource(reference, source)) return noEffect(false);
      bindSemanticProducerRoles(tx, roles);
      registerCommandCallback(tx, async (transactionId) => {
        await recordSemanticSourceCommit(tx, transactionId);
        await tx.query(appendSQL.sql, [
          reference.source.partition,
          retained.erasure_key,
          (BigInt(previous?.sequence ?? '0') + 1n).toString(),
          previous?.sequence ?? null,
          next.state,
          next.directory ? json(next.directory) : null,
          next.ticket,
          next.after ? json(next.after) : null,
          next.seal ? hash(next.seal) : null,
          next.fence?.partition ?? null,
          next.fence?.epoch ?? null,
          next.fence?.position.toString() ?? null,
          next.fence?.transactionId ?? null,
          generation.replayGeneration,
          generation.undoGeneration,
          generation.restoreGeneration,
          owner.epoch,
          transactionId,
          null,
          null,
          null,
          null,
        ]);
      });
      return {
        value: true,
        events: [
          {
            type: SEMANTIC_ERASURE_PROGRESS,
            subject: reference.barrier.accountId,
            data: { accountId: reference.barrier.accountId },
          },
        ],
      };
    })
  ).value;
}

/** One retained directory page and one native effect page per call. The saved cursor can
 * advance only after each exact scope has a durable later-writer fence, including sealed zero. */
async function advanceConsumers(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  roles: AccountIdentitySource['roles'],
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  const ports = await owners();
  const saved = (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
      noEffect(await latest(tx, retained)),
    )
  ).value;
  if (saved && terminal(saved.state)) {
    return verifiedTerminal(pool, reference, saved, deadline, identityConsumerWork);
  }
  const work = await ports.binding.readIdentitySourceConsumerWork?.(pool, reference, {
    deadline,
    identityConsumerWork,
  });
  if (!work || !validGeneration(work)) return null;
  const previous = saved && sameGeneration(generations(saved), work) ? saved : null;
  const allowance = new DirectoryWork(work.allowance).reserve();
  if (!allowance) return null;
  const directory = await readIdentityPrearmCustodyPage(
    pool,
    { job: reference.job, after: previous?.directory_after ?? null, limit: 1, allowance },
    { deadline, identityConsumerWork },
  );
  if (directory.status === 'unavailable') {
    // Native directory continuations are process-authenticated locators. A restart may
    // invalidate their MAC; restart enumeration without reusing any checked scope prefix.
    if (directory.reason === 'invalid-frontier' && previous?.directory_after)
      await checkpoint(
        pool,
        reference,
        retained,
        saved,
        work,
        { state: 'directory', directory: null, ticket: null, after: null, seal: null, fence: null },
        roles,
        deadline,
      );
    return null;
  }
  if (!boundedFrontier(directory.frontier) || directory.tickets.length > 1) return null;
  if (previous?.directory_after && json(directory.frontier) === json(previous.directory_after)) return null;
  const ticket = directory.tickets[0];
  if (ticket) {
    if (
      json(ticket.locator.job) !== json(reference.job) ||
      ticket.scope.source.kind !== 'library' ||
      ticket.scope.source.identity.scope === 'public_output'
    )
      return null;
    const reservation = await ports.scope.readIdentityScopeConsumerWork?.(pool, ticket, {
      deadline,
      identityConsumerWork,
    });
    if (!reservation || !ports.scope.retainIdentityScopeConsumerFence) return null;
    const budget = identitySourceConsumerLibraryWork(pool, identityConsumerWork, deadline);
    if (!budget) return null;
    const ticketKey = hash(ticket);
    const prior = previous?.state === 'scope' && previous.ticket_key === ticketKey ? previous : null;
    const key = { job: reference.job, sourceIdentity: ticket.scope.source.identity, scope: ticket.scope.scopeId };
    const planned = reservation.allowance.remaining;
    const beforePage = budget.receipt().used;
    const page = await budget.compose(
      (allowance) =>
        readLibraryScopeEffectsPage(pool, {
          ...key,
          after: prior?.effect_after ?? null,
          limit: 1,
          allowance,
          deadline,
        }),
      planned,
    );
    const afterPage = budget.receipt().used;
    const footprint = (sql: string, values: readonly unknown[]) => {
      const bound = reservation.footprint(sql, values);
      if (!bound) return undefined;
      return (Object.keys(planned) as (keyof WorkDimensions)[]).every(
        (axis) => afterPage[axis] - beforePage[axis] + bound[axis] <= planned[axis],
      )
        ? bound
        : undefined;
    };
    if (
      page.status !== 'sealed' ||
      page.rows.length > 1 ||
      json(page.seal.key) !== json(key) ||
      !boundedFrontier(page.seal.frontier) ||
      !page.seal.generation ||
      !page.seal.version ||
      (!page.exhausted && (!page.after || json(page.after) === json(prior?.effect_after ?? null)))
    )
      return null;
    if (prior?.seal_digest && prior.seal_digest !== hash(page.seal)) {
      // A changed seal restarts this scope, never reuses its previously checked prefix.
      await checkpoint(
        pool,
        reference,
        retained,
        saved,
        work,
        {
          state: 'scope',
          directory: previous?.directory_after ?? null,
          ticket: ticketKey,
          after: null,
          seal: null,
          fence: null,
        },
        roles,
        deadline,
      );
      return null;
    }
    const current = await instrumentNativeCollectionWork(pool, budget, footprint, async () => {
      for (const selection of page.rows) {
        const record = await readIdentityReceivingSelection(pool, selection, { deadline });
        if (!record || !matchesReceiving(ticket, selection, record) || !record.applied) return null;
        const applied = await reconcileIdentityReceivingEffect(pool, {
          kind: 'receiving',
          job: reference.job,
          original: selection.original,
          effectKey: selection.effectKey,
          receipt: record.receipt,
        });
        if (json(applied) !== json(record.applied.receipt)) return null;
      }
      // No foreign read under this local Source command. Revalidate the SAME seal even
      // for intermediate pages, then pin the complete cut before releasing this home.
      return runCommand<{ fence: IdentityNativeReceipt | null } | null>(
        pool,
        { partition: identityScopeAddress(ticket.scope).partition, deadline },
        async (tx) => {
          if (!(await verifyLibraryScopeEffectsSeal(tx, key, page.seal))) return noEffect(null);
          if (!page.exhausted) return noEffect({ fence: null });
          const fence = await ports.scope.retainIdentityScopeConsumerFence!(tx, ticket, page.seal);
          if (!fence) return noEffect(null);
          return {
            value: { fence },
            events: [
              {
                type: SEMANTIC_ERASURE_PROGRESS,
                subject: reference.barrier.accountId,
                data: { accountId: reference.barrier.accountId },
              },
            ],
          };
        },
      );
    });
    if (!current?.value) return null;
    const fence = current.value.fence;
    if (
      page.exhausted &&
      (!fence ||
        fence.partition !== current.partition ||
        fence.epoch !== current.epoch ||
        fence.position <= 0n ||
        fence.position > current.position ||
        (fence.transactionId === current.transactionId && fence.position !== current.position))
    )
      return null;
    if (!page.exhausted) {
      await checkpoint(
        pool,
        reference,
        retained,
        saved,
        work,
        {
          state: 'scope',
          directory: previous?.directory_after ?? null,
          ticket: ticketKey,
          after: page.after,
          seal: page.seal,
          fence: null,
        },
        roles,
        deadline,
      );
      return null;
    }
    if (directory.status !== 'complete') {
      await checkpoint(
        pool,
        reference,
        retained,
        saved,
        work,
        { state: 'directory', directory: directory.frontier, ticket: ticketKey, after: null, seal: page.seal, fence },
        roles,
        deadline,
      );
      return null;
    }
    // The last real scope fence is recorded before terminal transition, in the same final
    // source command below. No opaque directory cut or in-process Library brand is persisted.
    return finishConsumers(
      pool,
      reference,
      retained,
      saved,
      work,
      directory,
      ports,
      { state: 'directory', directory: directory.frontier, ticket: ticketKey, after: null, seal: page.seal, fence },
      roles,
      deadline,
      identityConsumerWork,
    );
  }
  if (directory.status !== 'complete') {
    if (json(directory.frontier) === json(previous?.directory_after ?? null)) return null;
    await checkpoint(
      pool,
      reference,
      retained,
      saved,
      work,
      { state: 'directory', directory: directory.frontier, ticket: null, after: null, seal: null, fence: null },
      roles,
      deadline,
    );
    return null;
  }
  return finishConsumers(
    pool,
    reference,
    retained,
    saved,
    work,
    directory,
    ports,
    { state: 'directory', directory: directory.frontier, ticket: null, after: null, seal: null, fence: null },
    roles,
    deadline,
    identityConsumerWork,
  );
}

type CompleteDirectory = Extract<Awaited<ReturnType<typeof readIdentityPrearmCustodyPage>>, { status: 'complete' }>;
async function finishConsumers(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  previous: Progress | null,
  generation: IdentitySourceConsumerGeneration,
  directory: CompleteDirectory,
  ports: Awaited<ReturnType<typeof owners>>,
  next: Next,
  roles: AccountIdentitySource['roles'],
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  if (!ports.binding.lockIdentitySourceConsumerCut || !ports.binding.verifyIdentitySourceConsumerCut) return null;
  let reversal: AccountIdentityReversalSettlement | null = null;
  if (reference.erasedRole === 'subject') {
    reversal =
      (await ports.technical.readAccountIdentityReversalSettlement?.(pool, reference, {
        deadline,
        identityConsumerWork,
      })) ?? null;
    if (!reversal) return null;
  }
  if (
    (await verifyIdentityPrearmCustodyCut(pool, reference.job, directory.cut, { deadline, identityConsumerWork }))
      .status !== 'current'
  )
    return null;
  // Last foreign probe is released. The local binding lock also belongs to every later
  // original-source admission/replay/undo/restore consumer, as required of the owner hook.
  const result = await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) => {
    const claim = await acceptedClaim(tx, reference);
    const saved = await latest(tx, retained);
    if (
      !claim ||
      claim.generation !== retained.binding_generation ||
      (saved?.sequence ?? null) !== (previous?.sequence ?? null)
    )
      return noEffect(false);
    const owner = await readPartition(tx, reference.source.partition);
    const source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
    if (!owner || owner.writeState !== 'active' || !sameSource(reference, source)) return noEffect(false);
    const disposition = await ports.binding.lockIdentitySourceConsumerCut!(
      tx,
      reference,
      generation,
      reversal ?? undefined,
    );
    if (
      !disposition ||
      (reference.erasedRole === 'subject' && disposition !== 'discharged') ||
      (reference.receipt.kind === 'account-agent.verify' &&
        reference.erasedRole !== 'subject' &&
        disposition !== 'transferred')
    )
      return noEffect(false);
    let receiving: IdentityNativeReceipt | null = null;
    if (disposition === 'transferred') {
      if (
        !ports.technical.acceptAccountIdentityTechnicalSource ||
        !ports.technical.verifyAccountIdentityTechnicalSource
      )
        return noEffect(false);
      receiving = await ports.technical.acceptAccountIdentityTechnicalSource(tx, reference);
      if (!receiving) return noEffect(false);
      if (
        receiving.partition !== reference.source.partition ||
        receiving.epoch !== owner.epoch ||
        receiving.position <= 0n ||
        !uuid.test(receiving.transactionId) ||
        !(await ports.technical.verifyAccountIdentityTechnicalSource(tx, reference, receiving))
      )
        throw new IdentityEpochStoreError('identity_effect_stale', 'Technical source acceptance lost native custody');
    }
    if (
      !(await ports.binding.verifyIdentitySourceConsumerCut!(
        tx,
        reference,
        generation,
        disposition,
        reversal ?? undefined,
      ))
    )
      throw new IdentityEpochStoreError('identity_effect_stale', 'Original consumer fence changed during transfer');
    bindSemanticProducerRoles(tx, roles);
    registerCommandCallback(tx, async (transactionId) => {
      await recordSemanticSourceCommit(tx, transactionId);
      await tx.query(appendSQL.sql, [
        reference.source.partition,
        retained.erasure_key,
        (BigInt(previous?.sequence ?? '0') + 1n).toString(),
        previous?.sequence ?? null,
        disposition,
        json(directory.frontier),
        next.ticket,
        null,
        next.seal ? hash(next.seal) : null,
        next.fence?.partition ?? null,
        next.fence?.epoch ?? null,
        next.fence?.position.toString() ?? null,
        next.fence?.transactionId ?? null,
        generation.replayGeneration,
        generation.undoGeneration,
        generation.restoreGeneration,
        owner.epoch,
        transactionId,
        receiving?.partition ?? null,
        receiving?.epoch ?? null,
        receiving?.position.toString() ?? null,
        receiving?.transactionId ?? null,
      ]);
    });
    return {
      value: true,
      events: [
        {
          type: SEMANTIC_ERASURE_PROGRESS,
          subject: reference.barrier.accountId,
          data: { accountId: reference.barrier.accountId },
        },
      ],
    };
  });
  if (!result.value) return null;
  const proof = Object.freeze({
    [locator]: Object.freeze({
      source: Object.freeze({
        partition: result.partition,
        epoch: result.epoch,
        position: result.position,
        transactionId: result.transactionId,
      }),
      reversal,
    }),
  }) as LocalProof;
  // Re-enter only this home after commit. The brand cannot replace durable live revalidation.
  return (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
      noEffect(await verifyIdentitySourceConsumerCustody(tx, reference, proof)),
    )
  ).value
    ? proof
    : null;
}

/** Same genuine live original-home command, fixed indexed points, no foreign checkout. */
export async function verifyIdentitySourceConsumerCustody(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  proof: IdentitySourceConsumerCustody,
): Promise<boolean> {
  const resources = currentCommandResources(tx);
  const frame = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  if (
    !frame ||
    !isLiveIdentitySourceConsumerMaintenance(resources.pool, frame, resources.deadline) ||
    !reserveIdentitySourceConsumerNativeWork(resources.pool, frame, {
      rows: 4,
      points: 4,
      statements: 6,
      bytes: 8192,
      engineRequests: 0,
    })
  )
    return false;
  if (
    !valid(reference) ||
    currentCommand(tx).partition !== reference.source.partition ||
    currentCommand(tx).basis !== null ||
    resources.deadline <= Date.now()
  )
    return false;
  const local = (proof as LocalProof | null)?.[locator];
  const native = local?.source;
  if (!native || native.partition !== reference.source.partition) return false;
  const retained = (await tx.query<Retained>(select.sql, referenceValues(reference))).rows[0];
  if (!retained || !(await acceptedClaim(tx, reference))) return false;
  const row = await latest(tx, retained);
  if (
    !row ||
    !terminal(row.state) ||
    row.transaction_id !== native.transactionId ||
    row.owner_epoch !== native.epoch ||
    BigInt(row.position) !== native.position ||
    !validGeneration(generations(row))
  )
    return false;
  if (
    (reference.erasedRole === 'subject' && row.state !== 'discharged') ||
    (reference.receipt.kind === 'account-agent.verify' &&
      reference.erasedRole !== 'subject' &&
      row.state !== 'transferred')
  )
    return false;
  const ports = await owners();
  if (
    !(await ports.binding.verifyIdentitySourceConsumerCut?.(
      tx,
      reference,
      generations(row),
      row.state,
      local.reversal ?? undefined,
    ))
  )
    return false;
  if (row.state !== 'transferred') return true;
  if (
    row.receiving_partition !== reference.source.partition ||
    row.receiving_epoch !== row.owner_epoch ||
    !row.receiving_position ||
    !row.receiving_transaction_id
  )
    return false;
  const receiving = {
    partition: row.receiving_partition,
    epoch: row.receiving_epoch,
    position: BigInt(row.receiving_position),
    transactionId: row.receiving_transaction_id,
  };
  return (await ports.technical.verifyAccountIdentityTechnicalSource?.(tx, reference, receiving)) === true;
}

type HistoryNativeLocator = Omit<IdentityNativeReceipt, 'position'> & Readonly<{ position: string }>;
export type IdentitySourceHistoryReference = Omit<IdentitySourceConsumerReference, 'source' | 'job'> &
  Readonly<{
    source: HistoryNativeLocator;
    job: Readonly<{ jobId: string; epoch: string }>;
  }>;

/** Persistable address of original Source authority, never a portable certificate.
 * The native consumer must resolve this SAME original row through the Source function
 * on every guarded transition, including the later receiving commit. */
export type IdentitySourceHistoryAuthority = Readonly<{
  kind: 'identity-source-history-guard/v1';
  custody: string;
  sequence: string;
  reference: IdentitySourceHistoryReference;
  generation: IdentitySourceConsumerGeneration;
  disposition: IdentitySourceConsumerDisposition;
  terminal: HistoryNativeLocator;
  receiving: HistoryNativeLocator | null;
}>;

/** Outer SELECT, fifteen exact native keyed inputs, and the returned native tuple.
 * There are two SQL statements: the outer SELECT and the function's joined SELECT.
 * PL/pgSQL comparisons/RETURN dispatch no SQL and this read fires no row triggers. */
export const IDENTITY_SOURCE_HISTORY_GUARD_COST: NativeStepWork = Object.freeze({
  rows: 17,
  points: 15,
  statements: 2,
  bytes: 32768,
  engineRequests: 0,
});

// Additional fixed calls in the supported composition below. Source and Account
// verifiers still pre-reserve their OWN work; these allowances never replace it.
export const IDENTITY_SOURCE_HISTORY_RECHECK_COST: NativeStepWork = Object.freeze({
  rows: 32,
  points: 32,
  statements: 8,
  bytes: 131072,
  engineRequests: 0,
});
export const IDENTITY_SOURCE_HISTORY_RECEIVER_COST: NativeStepWork = Object.freeze({
  rows: 160,
  points: 80,
  statements: 6,
  bytes: 131072,
  engineRequests: 0,
});

export type IdentitySourceHistoryHandoff = Readonly<{
  phase: 'readiness' | 'closure';
  sourceAuthority: IdentitySourceHistoryAuthority;
  binding: AgentIdentitySDKReceivingBinding;
  writer: SdkWriterState;
}>;
export type IdentitySourceHistoryHandoffResult =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'guarded'; handoff: IdentitySourceHistoryHandoff }>;

function reserveHistoryWork(tx: CommandTransaction, cost: NativeStepWork): boolean {
  const resources = currentCommandResources(tx);
  const frame = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  return !!frame && reserveIdentitySourceConsumerNativeWork(resources.pool, frame, cost);
}

/** Resolve durable ORIGINAL Source state, not a copied terminal receipt. This same
 * function is the supported native Source half of History's future row guard:
 * semantic.lock_identity_source_history_handoff(reference, expectedAuthority).
 * It locks original custody, current binding/generations and native enrollment until
 * COMMIT. It does not supply Account verification, SDK closure or History readiness. */
export async function lockIdentitySourceHistoryAuthority(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  expected: IdentitySourceHistoryAuthority | null = null,
): Promise<IdentitySourceHistoryAuthority | null> {
  const serialized = json(reference);
  const expectedJSON = expected === null ? null : json(expected);
  if (
    !valid(reference) ||
    Buffer.byteLength(serialized) > 2048 ||
    (expectedJSON !== null && Buffer.byteLength(expectedJSON) > 4096) ||
    reference.source.partition !== 0 ||
    partitionOf(reference.barrier.accountRoute) !== 0 ||
    currentCommand(tx).partition !== 0 ||
    currentCommand(tx).basis !== null ||
    !reserveHistoryWork(tx, IDENTITY_SOURCE_HISTORY_GUARD_COST)
  )
    return null;
  return (
    await tx.query<{ authority: IdentitySourceHistoryAuthority | null }>(historySQL.sql, [
      serialized,
      expectedJSON,
    ])
  ).rows[0]?.authority ?? null;
}

/** Default owner composition on the genuine original Source command. Both phases
 * re-run native History/Source/Account verification and exact receiving admission,
 * then lock the actual SDK state on this SAME command. No foreign SQL, callbacks,
 * fresh frame, SDK retirement or History state mutation is substituted here.
 *
 * History owns persisting distinct guarded readiness/closure transitions. Its native
 * row guard must consume the Source function with the stored exact authority AND
 * its own current association, barrier, receiver and SDK prerequisites. Returning
 * this locator cannot authorize a later write by itself. */
export async function lockIdentitySourceHistoryHandoff(
  tx: CommandTransaction,
  stage: AgentIdentityRetirementStage,
  binding: AgentIdentitySDKReceivingBinding,
  expectedWriter: SdkWriterState,
  phase: 'readiness' | 'closure',
  sdk: DBOSClient,
): Promise<IdentitySourceHistoryHandoffResult> {
  const pending = (gap: string): IdentitySourceHistoryHandoffResult => ({ state: 'pending', gap });
  const reference = stage.reference;
  if (!valid(reference) || currentCommand(tx).basis !== null)
    return pending('identity-source-history-reference-changed');
  // No receiving-home read may be smuggled into a different Source command. Shared
  // PostgreSQL placement alone does not establish single-partition atomicity.
  if (
    reference.source.partition !== 0 ||
    currentCommand(tx).partition !== 0 ||
    partitionOf(reference.barrier.accountRoute) !== 0
  )
    return pending('identity-source-history-shared-home-unavailable');
  if (
    (phase !== 'readiness' && phase !== 'closure') ||
    expectedWriter.workflowID !== binding.workflowId ||
    expectedWriter.workflowID !== stage.handoff.source.workflowId ||
    (phase === 'readiness'
      ? expectedWriter.generation !== '1' || expectedWriter.closureID !== null || expectedWriter.closedAt !== null
      : expectedWriter.generation !== '2' ||
        !expectedWriter.closureID ||
        !Number.isSafeInteger(expectedWriter.closedAt) ||
        expectedWriter.closedAt! <= 0) ||
    !sameHistoryBinding(stage, binding)
  )
    return pending('identity-source-history-binding-or-writer-changed');
  // Clone data across the awaited owner calls; preserve only the actual Source proof.
  stage = { reference: structuredClone(reference), handoff: structuredClone(stage.handoff), consumer: stage.consumer };
  binding = structuredClone(binding);
  expectedWriter = structuredClone(expectedWriter);
  if (!reserveHistoryWork(tx, IDENTITY_SOURCE_HISTORY_RECHECK_COST))
    return pending('identity-source-history-funding-unavailable');
  const { verifyAgentIdentityRetirementStage } = await import('../history/agent-identity-retirement.ts');
  const source = await verifyAgentIdentityRetirementStage(tx, stage);
  if (source.state === 'pending') return source;
  if (source.custodyId !== binding.custodyId || source.workflowId !== binding.workflowId)
    return pending('identity-source-history-association-changed');
  if (!reserveHistoryWork(tx, IDENTITY_SOURCE_HISTORY_RECEIVER_COST))
    return pending('identity-source-history-funding-unavailable');
  const { readAgentIdentitySDKReceivingBinding } = await import('../history/agent-identity-sdk-fence.ts');
  const receiver = await readAgentIdentitySDKReceivingBinding(
    tx,
    {
      partition: 0,
      locator: { artifactType: 'durable-work/v1', workId: binding.custodyId },
      accounts: binding.source.accounts,
    },
    stage.reference.barrier,
  );
  if (receiver.state === 'pending') return receiver;
  if (json(receiver.binding) !== json(binding)) return pending('identity-source-history-receiver-changed');
  const sourceAuthority = await lockIdentitySourceHistoryAuthority(tx, stage.reference);
  if (!sourceAuthority) return pending('identity-source-history-native-custody-pending');
  // SDK owner cost, including its nested domain/fence locks and return SELECT.
  // Stale, pool, serialization and deadlock failures propagate: roll back the whole
  // command. Every repeated entry pre-reserves again in the SAME live frame.
  if (!reserveHistoryWork(tx, {
    rows: SDK_TRANSACTION_FENCE_COST.rows,
    points: SDK_TRANSACTION_FENCE_COST.points,
    statements: SDK_TRANSACTION_FENCE_COST.statements,
    bytes: SDK_TRANSACTION_FENCE_COST.bytes,
    engineRequests: SDK_TRANSACTION_FENCE_COST.engineWork,
  }))
    return pending('identity-source-history-funding-unavailable');
  let writer: SdkWriterState;
  try {
    writer = await lockSdkWorkflowWriterState(tx, expectedWriter, sdk);
  } catch (error) {
    if (error instanceof Error && error.message === 'DBOS writer fence requires the same native transaction pool')
      return pending('identity-source-history-sdk-pool-mismatch');
    throw error;
  }
  return { state: 'guarded', handoff: { phase, sourceAuthority, binding: receiver.binding, writer } };
}

function sameHistoryBinding(stage: AgentIdentityRetirementStage, binding: AgentIdentitySDKReceivingBinding): boolean {
  return (
    binding.custodyId === stage.handoff.custodyId &&
    binding.workflowId === stage.handoff.source.workflowId &&
    binding.receiver.partition === 0 &&
    binding.receiver.writerVersion === 1 &&
    binding.receiver.generation === stage.handoff.generation &&
    json(binding.source) === json(stage.handoff.source) &&
    json(binding.barrier) === json(stage.reference.barrier)
  );
}
