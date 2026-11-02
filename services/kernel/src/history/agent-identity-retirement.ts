import type {
  IdentitySourceConsumerCustody,
  IdentitySourceConsumerReference,
} from '../semantic/identity-source-consumer-custody.ts';
import canonicalize from 'canonicalize';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  identityHistoryCommand,
  identityHistoryConnection,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  reserveIdentityHistoryWork,
  nativeWork,
  unpricedIdentityHistoryWork,
  IdentityHistoryWorkUnavailable,
} from './agent-identity-inventory-work.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkClient } from '../work/client.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import {
  agentIdentityWorkSourceKey,
  agentIdentitySourceKey,
  type AgentIdentityReceipt,
  type AgentIdentityWorkSource,
} from './agent-identity-source.ts';
import {
  AGENT_IDENTITY_SDK_FENCE_CONSUMER,
  IDENTITY_HISTORY_HANDOFF_UNAVAILABLE,
  readAgentIdentitySDKFence,
  readAgentIdentitySDKReceivingBinding,
  type AgentIdentitySDKRetirementReceipt,
} from './agent-identity-sdk-fence.ts';
import {
  historyDeadline,
  lockHistoryBarrier,
  readHistoryReceivingReceipt,
  type HistoryReceivingContext,
} from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryReadiness } from './registry.ts';
import type { AgentIdentityOriginal } from './agent-identity-inventory.ts';
import { partitionOf } from '../route/route.ts';
import sourceSelect from './agent-identity-retirement-source.sql';
import type {
  HistoryOriginalDependencies,
  IdentityOriginalSourceContext,
  PrepaidAgentIdentityHistoryUnit,
} from '../access/identity-original-admission.ts';
import type { IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';

// Reuse the integrated producer's opaque work identity across the receiving boundary.
export type {
  IdentitySourceConsumerMaintenanceWork,
  IdentitySourceConsumerMaintenanceContext,
} from '../semantic/identity-source-consumer-maintenance.ts';
export type IdentitySourceConsumerMaintenanceModule = Pick<
  typeof import('../semantic/identity-source-consumer-maintenance.ts'),
  'withIdentitySourceConsumerMaintenance'
>;

/** Released foreign staging is not cleanup authority. The receiving owner must verify
 * the original source and its native terminal transfer before settling its obligation. */
export type AgentIdentityRetirementStage = Readonly<{
  handoff: Readonly<{ custodyId: string; source: AgentIdentityWorkSource; generation: string }>;
  reference: IdentitySourceConsumerReference;
  consumer: IdentitySourceConsumerCustody | null;
}>;

export type AgentIdentityRetirementResult =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'verified'; gap: null; custodyId: string; workflowId: string }>;

/** Semantic terminal custody and the SDK writer fence are separate prerequisites to
 * retiring the retained receiving work. */
export const AGENT_IDENTITY_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.5.3-preview',
  futureWriters: 'native-sdk-fence-requires-source-transfer',
  gap: AGENT_IDENTITY_SDK_FENCE_CONSUMER.gap,
} as const);

const pending = (gap: string) => ({ state: 'pending', gap }) as const;
const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
// Only contexts delivered to the actual producer callback may dispatch this caller's
// Source staging. This tracks the call site, not funding validity or Source authority;
// the producer still owns validation, accounting and invalidation of its opaque work.
const maintenanceCallbacks = new WeakSet<HistoryReceivingContext>();

export const IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE = 'identity-source-maintenance-funding-unavailable';
export const IDENTITY_SOURCE_PREPAID_MAINTENANCE_UNAVAILABLE = 'identity-source-prepaid-maintenance-not-installed';
export { IDENTITY_HISTORY_HANDOFF_UNAVAILABLE } from './agent-identity-sdk-fence.ts';

/** Decode only the original native association's closed key. No workflow-name parsing,
 * source reconstruction or new admission is permitted at this boundary. */
function sourceReceipt(source: AgentIdentityWorkSource): AgentIdentityReceipt | null {
  if (Buffer.byteLength(source.key) > 256) return null;
  let tuple: unknown;
  try {
    tuple = JSON.parse(source.key);
  } catch {
    return null;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    (tuple[0] !== 'account-agent.verify' && tuple[0] !== 'account-agent.unverify') ||
    typeof tuple[1] !== 'string' ||
    typeof tuple[2] !== 'string'
  )
    return null;
  const receipt: AgentIdentityReceipt = { kind: tuple[0], account: tuple[1], receipt: tuple[2] };
  return agentIdentityWorkSourceKey(receipt) === source.key ? receipt : null;
}

/** One selected native identity unit, after the scheduler has released its job checkout.
 * Only the actual Source runtime export may enter this callback. Its frame spans the
 * released receiver/source/accepted-job reads, Source staging and final native verifier.
 * Neither this entry nor its opaque funding grants any retirement/SDK authority. */
export async function advanceAgentIdentityConsumerMaintenance(
  deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
  }>,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
  context: HistoryReceivingContext,
): Promise<string | null> {
  historyDeadline(context, artifact.partition);
  if (artifact.partition !== 0 || artifact.locator.artifactType !== 'durable-work/v1')
    return 'identity-sdk-receiving-home-mismatch';
  assertAgentIdentityHistoryUnit(deps.pool, context, deps.client);
  const active = currentAgentIdentityHistoryUnit();
  if (active) return advanceInFrame(deps, artifact, barrier, active.context);
  try {
    return await withAgentIdentityHistoryUnit(deps, context, (funded) =>
      advanceInFrame(deps, artifact, barrier, funded),
    );
  } catch (error) {
    if (error instanceof IdentityHistoryWorkUnavailable) return error.message;
    throw error;
  }
}

type IdentityUnit = {
  context: HistoryReceivingContext;
  stage?: AgentIdentityRetirementStage;
  client?: WorkClient;
  active: boolean;
  prepaid?: Readonly<{
    deps: HistoryOriginalDependencies;
    parent: IdentityOriginalSourceContext;
    owner: Pick<
      typeof import('../semantic/identity-source-consumer-maintenance.ts'),
      'isLiveIdentitySourceConsumerMaintenance' | 'identitySourceConsumerLibraryWork'
    >;
  }>;
  failure?: Error;
};
// Resolve this owner only when the prepaid entry is actually invoked. Its Library
// accounting dependency imports HTTP ProblemError, which itself constructs the
// command/History graph. An eager edge from History would re-enter HTTP startup.
// Cached operations convey no authority: every use authenticates the real grant.
let originalOperations: typeof import('../access/identity-original-admission.ts') | undefined;
function originalUnavailable(gap: string): Error {
  if (originalOperations) return new originalOperations.IdentityOriginalUnavailable(gap);
  const error = new IdentityHistoryWorkUnavailable();
  error.message = gap;
  return error;
}
const identityUnits = new AsyncLocalStorage<IdentityUnit>();
const prepaidContexts = new WeakMap<HistoryReceivingContext, IdentityUnit>();
export function currentAgentIdentityHistoryUnit(): Readonly<IdentityUnit> | undefined {
  const unit = identityUnits.getStore();
  if (unit && (!unit.active || unit.failure)) throw unit.failure ?? new IdentityHistoryWorkUnavailable();
  if (unit?.prepaid) {
    try {
      assertPrepaidParent(unit.prepaid.deps, unit.prepaid.parent);
      if (
        !unit.prepaid.owner.isLiveIdentitySourceConsumerMaintenance(
          unit.prepaid.deps.pool,
          unit.context.identityConsumerWork,
          unit.context.deadline,
        ) ||
        unit.prepaid.owner.identitySourceConsumerLibraryWork(
          unit.prepaid.deps.pool,
          unit.context.identityConsumerWork,
          unit.context.deadline,
        ) !== unit.prepaid.parent.library
      )
        throw originalUnavailable('identity-history-prepaid-source-context-changed');
    } catch (error) {
      // Restoring a mutated dependency or clock after catching a refusal cannot
      // revive this callback. Core's already-held cleanup does not use this guard.
      unit.failure ??=
        error instanceof Error ? error : originalUnavailable('identity-history-prepaid-source-context-changed');
      throw unit.failure;
    }
  }
  return unit;
}

/** Re-entering poisons the enclosing unit even when the caller catches the refusal. */
function refuseNestedUnit(): void {
  const enclosing = identityUnits.getStore();
  if (!enclosing) return;
  const error = originalUnavailable('identity-history-unit-reentered');
  enclosing.failure ??= error;
  throw error;
}

/** Producer operations are the authority. No local brand, environment setting or
 * comparison with a later database head can reconstruct the original grant. */
function assertPrepaidParent(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext): void {
  if (!parent || typeof parent !== 'object')
    throw originalUnavailable('identity-history-original-private-grant-unavailable');
  if (!originalOperations) throw originalUnavailable('identity-history-original-owner-unavailable');
  const { identityOriginalLibraryWork, currentIdentityOriginalTransfer, identityOriginalRemainder } =
    originalOperations;
  const ledger = identityOriginalLibraryWork(deps, parent.original, parent.jobId);
  const root = currentIdentityOriginalTransfer(deps, parent.jobId);
  if (!root) throw originalUnavailable('identity-history-original-handle-unavailable');
  const original = identityOriginalRemainder(deps, root, parent.jobId);
  if (
    parent.originalId !== original.originalId ||
    parent.deadline !== original.deadline ||
    parent.position !== original.position ||
    parent.native !== original.source ||
    parent.library !== ledger ||
    original.source === null ||
    original.library === null
  )
    throw originalUnavailable('identity-history-original-private-parent-changed');
}

/** Validate the exact callback context, actual Pool/client and original lifetime.
 * A deadline-only native command may inherit this frame; a copied explicit token
 * context cannot replace the producer callback's object. */
export function assertAgentIdentityHistoryUnit(
  pool: Pool,
  context?: HistoryReceivingContext,
  client?: WorkClient,
): void {
  currentAgentIdentityHistoryUnit();
  const unit = identityUnits.getStore();
  const bound = context && prepaidContexts.get(context);
  if (bound && bound !== unit) {
    const error = originalUnavailable('identity-history-prepaid-callback-ended');
    // A genuine token from another callback is still foreign to this unit. As
    // with a copied token, catching its refusal must not revive the live unit.
    if (unit?.prepaid) unit.failure ??= error;
    throw error;
  }
  if (!unit?.prepaid) return;
  if (
    pool !== unit.prepaid.deps.pool ||
    (client !== undefined && client !== unit.client) ||
    (context !== undefined &&
      (context.deadline !== unit.context.deadline ||
        ('identityConsumerWork' in context && context !== unit.context))) ||
    !maintenanceCallbacks.has(unit.context)
  ) {
    const error = originalUnavailable('identity-history-prepaid-context-changed');
    unit.failure ??= error;
    throw error;
  }
}

/** Source's agreed receiving ABI. Loading this callable conveys no grant. The
 * installed Source owner must authenticate the live parent and keep its existing
 * maintenance context and exact original Library ledger throughout the callback. */
type PrepaidSourceMaintenance = <T>(
  deps: HistoryOriginalDependencies,
  parent: IdentityOriginalSourceContext,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
) => Promise<T>;
const enteredPrepaidParents = new WeakSet<IdentityOriginalSourceContext['original']>();

export const withPrepaidAgentIdentityHistoryUnit: PrepaidAgentIdentityHistoryUnit = async (deps, parent, body) => {
  refuseNestedUnit();
  originalOperations = await import('../access/identity-original-admission.ts');
  assertPrepaidParent(deps, parent);
  if (enteredPrepaidParents.has(parent.original)) throw originalUnavailable('identity-history-unit-already-entered');
  // Failure, missing export and a rejected callback all consume this entry. Accounts'
  // producer already owns durable admission/transfer; never consume or transfer again.
  enteredPrepaidParents.add(parent.original);
  const producer: typeof import('../semantic/identity-source-consumer-maintenance.ts') &
    Partial<{ withPrepaidIdentitySourceConsumerMaintenance: PrepaidSourceMaintenance }> =
    await import('../semantic/identity-source-consumer-maintenance.ts');
  assertPrepaidParent(deps, parent);
  const descriptor = Object.getOwnPropertyDescriptor(producer, 'withPrepaidIdentitySourceConsumerMaintenance');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
    throw originalUnavailable(IDENTITY_SOURCE_PREPAID_MAINTENANCE_UNAVAILABLE);
  const enter = producer.withPrepaidIdentitySourceConsumerMaintenance!;
  let delivered = false;
  let completed = false;
  let callbackFailure: unknown;
  let callbackFailed = false;
  const answer = await enter(deps, parent, async (funded) => {
    assertPrepaidParent(deps, parent);
    if (
      delivered ||
      !funded ||
      funded.deadline !== parent.deadline ||
      !producer.isLiveIdentitySourceConsumerMaintenance(deps.pool, funded.identityConsumerWork, parent.deadline) ||
      producer.identitySourceConsumerLibraryWork(deps.pool, funded.identityConsumerWork, parent.deadline) !==
        parent.library
    ) {
      callbackFailed = true;
      callbackFailure = originalUnavailable('identity-history-prepaid-source-context-changed');
      throw callbackFailure;
    }
    delivered = true;
    const unit: IdentityUnit = {
      context: funded,
      client: deps.client,
      active: true,
      prepaid: { deps, parent, owner: producer },
    };
    prepaidContexts.set(funded, unit);
    maintenanceCallbacks.add(funded);
    return withSingleCommandAttempt(() =>
      withRequestDeadline(parent.deadline, () =>
        identityUnits.run(unit, async () => {
          try {
            assertAgentIdentityHistoryUnit(deps.pool, funded, deps.client);
            const value = await body(funded);
            assertAgentIdentityHistoryUnit(deps.pool, funded, deps.client);
            completed = true;
            return value;
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            throw error;
          } finally {
            unit.active = false;
            maintenanceCallbacks.delete(funded);
          }
        }),
      ),
    );
  });
  assertPrepaidParent(deps, parent);
  if (callbackFailed) throw callbackFailure;
  if (!delivered || !completed) throw originalUnavailable('identity-history-prepaid-source-callback-missing');
  return answer;
};

/** The default scheduler enters this AFTER selection releases its checkout. The only
 * Source frame and deadline survive physical cleanup and the final receiving COMMIT. */
export async function withAgentIdentityHistoryUnit<T>(
  deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
    client?: WorkClient;
  }>,
  context: HistoryReceivingContext,
  body: (funded: HistoryReceivingContext) => Promise<T>,
): Promise<T> {
  if (identityUnits.getStore()) throw new TypeError('Identity History unit cannot replace its Source frame');
  const producer = await import('../semantic/identity-source-consumer-maintenance.ts');
  const inherited = producer.activeIdentitySourceConsumerMaintenance(deps.pool);
  // Presence survives an invalid/settled frame. Never turn its failed validation,
  // or an explicit foreign token, into permission to allocate another balance.
  if (
    !Number.isFinite(context.deadline) ||
    context.deadline <= Date.now() ||
    (context.identityConsumerWork !== undefined && context.identityConsumerWork !== inherited?.identityConsumerWork) ||
    (inherited && !producer.isLiveIdentitySourceConsumerMaintenance(deps.pool, inherited.identityConsumerWork))
  )
    throw new IdentityHistoryWorkUnavailable();
  const enter = (funded: HistoryReceivingContext) => {
    maintenanceCallbacks.add(funded);
    return withSingleCommandAttempt(() =>
      withRequestDeadline(funded.deadline, () =>
        identityUnits.run(
          { context: funded, active: true, ...(deps.client === undefined ? {} : { client: deps.client }) },
          async () => {
            try {
              return await body(funded);
            } finally {
              identityUnits.getStore()!.active = false;
              maintenanceCallbacks.delete(funded);
            }
          },
        ),
      ),
    );
  };
  if (inherited)
    return enter(
      inherited.deadline <= context.deadline ? inherited : Object.freeze({ ...inherited, deadline: context.deadline }),
    );
  return producer.withIdentitySourceConsumerMaintenance(deps, context, enter);
}

async function advanceInFrame(
  deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
  }>,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
  funded: HistoryReceivingContext,
): Promise<string | null> {
  historyDeadline(funded, artifact.partition);
  await reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.receivingBinding, funded);
  const receiving = await identityHistoryCommand(deps.pool, funded, (tx) =>
    readAgentIdentitySDKReceivingBinding(tx, artifact, barrier),
  );
  if (receiving.state === 'pending') return receiving.gap;
  const source = receiving.binding.source;
  const receipt = sourceReceipt(source);
  if (!receipt) return 'identity-sdk-source-native-binding-changed';
  const { readAccountIdentitySource } = await import('../access/agent-verification-identity.ts');
  await reserveIdentityHistoryWork(
    deps.pool,
    unpricedIdentityHistoryWork('source-original-native-read', nativeWork(70, 68, 25, 73984)),
    funded,
  );
  const readNative = (tx: CommandTransaction) => readAccountIdentitySource(tx, receipt, undefined, true);
  const native = currentAgentIdentityHistoryUnit()?.prepaid
    ? await identityHistoryCommand(deps.pool, funded, readNative, source.partition)
    : (
        await runCommand(deps.pool, { partition: source.partition, deadline: funded.deadline }, async (tx) =>
          noEffect(await readNative(tx)),
        )
      ).value;
  if (
    native.partition !== source.partition ||
    native.epoch !== source.epoch ||
    native.position.toString() !== source.position ||
    native.transactionId !== source.transactionId ||
    native.digest !== source.digest ||
    native.workflowId !== source.workflowId ||
    native.input.intent.release !== source.release
  )
    return 'identity-sdk-source-native-binding-changed';
  // The original source owns the erased role; a receiver's manifest alone is not
  // authority to select a role or to supply an accepted identity job.
  const role = native.roles.find((entry) => entry.account_id === barrier.accountId)?.role;
  const erasedRole =
    role === 'subject' ? 'subject' : role === 'actor' ? 'requester' : role === 'editor' ? 'decider' : null;
  if (!erasedRole) return 'identity-sdk-retirement-role-scope-changed';
  const { readOriginalAccountAgentIdentity } = await import('../semantic/account-agent-identity-recovery.ts');
  // The original accepted lookup has at most three command attempts and six RR
  // snapshots on unmerge; all SQL/control/failure slots are reserved before entry.
  await reserveIdentityHistoryWork(
    deps.pool,
    unpricedIdentityHistoryWork('source-accepted-original-recovery-read', nativeWork(86, 80, 59, 205920)),
    funded,
  );
  const accepted = await readOriginalAccountAgentIdentity(deps.pool, {
    account: receipt.account,
    direction: receipt.kind,
    receipt: receipt.receipt,
  });
  historyDeadline(funded, source.partition);
  if (!accepted || accepted.digest !== native.digest) return 'identity-source-consumer-custody-pending';
  const stage = await readAgentIdentityRetirementStage(
    deps.pool,
    {
      receipt,
      job: accepted.job,
      source: {
        partition: native.partition,
        epoch: native.epoch,
        position: native.position,
        transactionId: native.transactionId,
      },
      sourceDigest: native.digest,
      barrier,
      erasedRole,
    },
    funded,
  );
  if (!stage) return 'identity-sdk-retirement-source-fence-changed';
  if (
    stage.handoff.custodyId !== receiving.binding.custodyId ||
    stage.handoff.generation !== receiving.binding.receiver.generation ||
    !same(stage.handoff.source, source)
  )
    return 'identity-sdk-retirement-source-fence-changed';
  const unit = identityUnits.getStore();
  if (unit) unit.stage = stage;
  const { retireAgentIdentitySDKWork } = await import('./agent-identity-sdk-fence.ts');
  const verified = await retireAgentIdentitySDKWork(deps.pool, deps.client, stage, funded);
  return verified.state === 'pending' ? verified.gap : null;
}

/** SAME source home only. Re-read native source bytes and the immutable original SDK
 * association. An opaque UUID, portable source tuple or successful workflow is insufficient. */
async function sourceHandoff(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
): Promise<AgentIdentityRetirementStage['handoff'] | null> {
  if (currentCommand(tx).partition !== reference.source.partition || currentCommand(tx).basis !== null)
    throw new TypeError('Identity retirement requires its SAME native source home');
  const { readAccountIdentitySource } = await import('../access/agent-verification-identity.ts');
  const native = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
  const role = { subject: 'subject', requester: 'actor', decider: 'editor' }[reference.erasedRole];
  if (
    native.partition !== reference.source.partition ||
    native.epoch !== reference.source.epoch ||
    native.position !== reference.source.position ||
    native.transactionId !== reference.source.transactionId ||
    native.digest !== reference.sourceDigest ||
    !native.roles.some((entry) => entry.account_id === reference.barrier.accountId && entry.role === role)
  )
    return null;
  const row = (
    await tx.query(sourceSelect.sql, [
      native.partition,
      agentIdentityWorkSourceKey(reference.receipt),
      native.epoch,
      native.position.toString(),
      native.transactionId,
      native.digest,
      native.input.intent.release,
      native.workflowId,
    ])
  ).rows[0];
  return row ? { custodyId: row.custody_id, source: row.source, generation: row.generation } : null;
}

/** Stage only on RELEASED checkouts. Semantic performs its own exact accepted-job,
 * publication and consumer-cut probes; no receiver/source transaction is held during them.
 * An unavailable or incomplete native cut remains null and retains every byte. */
export async function readAgentIdentityRetirementStage(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  context: HistoryReceivingContext,
): Promise<AgentIdentityRetirementStage | null> {
  const fixed = structuredClone(reference);
  historyDeadline(context, fixed.source.partition);
  // Explicit expired/foreign tokens must fail even when no callback is active.
  // A deadline-only independent caller retains its existing admission responsibility.
  await reserveIdentityHistoryWork(pool, nativeWork(73, 71, 26, 82176), context);
  const handoff = await withSingleCommandAttempt(
    async () =>
      (
        await runCommand(pool, { partition: fixed.source.partition, deadline: context.deadline }, async (tx) =>
          noEffect(await sourceHandoff(tx, fixed)),
        )
      ).value,
  );
  if (!handoff) return null;
  // Deadline-only callers retain compatible local staging, but cannot dispatch Source.
  // Source itself validates the original live frame, including foreign/ended values.
  const consumer =
    context.identityConsumerWork === undefined || !maintenanceCallbacks.has(context)
      ? null
      : await (
          await import('../semantic/identity-source-consumer-custody.ts')
        ).readIdentitySourceConsumerCustody(pool, fixed, context);
  historyDeadline(context, fixed.source.partition);
  return { handoff, reference: fixed, consumer };
}

/** Foreign staging cannot grant source retirement. Recheck its exact barrier, source
 * generation/restore/writer and native Semantic terminal receipt in this SAME source
 * transaction. No foreign reads occur here. SDK writer retirement remains separate. */
export async function verifyAgentIdentityRetirementStage(
  tx: CommandTransaction,
  stage: AgentIdentityRetirementStage,
): Promise<AgentIdentityRetirementResult> {
  if (currentCommand(tx).partition !== stage.reference.source.partition || currentCommand(tx).basis !== null)
    throw new TypeError('Identity retirement requires its SAME native source home');
  historyDeadline(currentCommandResources(tx), stage.reference.source.partition);
  if (partitionOf(stage.reference.barrier.accountRoute) !== stage.reference.source.partition)
    return pending('agent-identity-source-barrier-home-unavailable');
  if (!(await lockHistoryBarrier(tx, stage.reference.barrier)))
    return pending('identity-sdk-retirement-barrier-changed');
  const handoff = await sourceHandoff(tx, stage.reference);
  if (!handoff || !same(handoff, stage.handoff)) return pending('identity-sdk-retirement-source-fence-changed');
  const { verifyIdentitySourceConsumerCustody } = await import('../semantic/identity-source-consumer-custody.ts');
  if (!stage.consumer || !(await verifyIdentitySourceConsumerCustody(tx, stage.reference, stage.consumer)))
    return pending('identity-source-consumer-custody-pending');
  return {
    state: 'verified',
    gap: null,
    custodyId: handoff.custodyId,
    workflowId: handoff.source.workflowId,
  };
}

/** Receiver-local preconditions only. A durable SDK receipt is recorded only after Semantic
 * terminal custody has been verified on the original source home and the SDK writer fence
 * has been installed. This check makes no foreign reads. */
export async function agentIdentityRetirementReadiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<HistoryReadiness> {
  const { pool, deadline } = currentCommandResources(tx);
  await reserveIdentityHistoryWork(pool, nativeWork(74, 74, 7, 49152), { deadline });
  const receiving = await readAgentIdentitySDKReceivingBinding(tx, artifact, barrier);
  if (receiving.state === 'pending') return { ready: false, gap: receiving.gap };
  const row = (
    await tx.query<{ sdk_retirement_receipt: AgentIdentitySDKRetirementReceipt | null }>(
      `SELECT m.sdk_retirement_receipt FROM core.agent_identity_work m
       JOIN core.history_work w ON w.partition_no=0 AND w.work_id=m.custody_id
         AND w.owner='access.agent-identity' AND w.request_digest=m.request_digest
       WHERE m.custody_id=$1 FOR SHARE OF m,w`,
      [receiving.binding.custodyId],
    )
  ).rows[0];
  const receipt = row?.sdk_retirement_receipt;
  if (
    !receipt ||
    receipt.sourceGeneration !== receiving.binding.receiver.generation ||
    !same(receipt.binding, receiving.binding)
  )
    return { ready: false, gap: AGENT_IDENTITY_SDK_RETIREMENT.gap };
  const unit = currentAgentIdentityHistoryUnit();
  if (!unit?.stage || !unit.client) return { ready: false, gap: IDENTITY_HISTORY_HANDOFF_UNAVAILABLE };
  if (
    artifact.locator.artifactType !== 'durable-work/v1' ||
    artifact.locator.workId !== unit.stage.handoff.custodyId ||
    !same(barrier, unit.stage.reference.barrier)
  )
    return { ready: false, gap: 'identity-history-current-unit-changed' };
  const { lockRecordedAgentIdentityHistory } = await import('./agent-identity-sdk-fence.ts');
  const held = await lockRecordedAgentIdentityHistory(tx, unit.client, unit.stage, unit.context);
  return held.state === 'guarded' ? { ready: true } : { ready: false, gap: held.gap };
}

/** Released SDK receiving observation for inventory presentation. It cannot be used in the
 * source transaction as a certificate. Old executions remain explicitly uncovered. */
export async function readAgentIdentitySDKRetirementGap(
  pool: Pool,
  receipt: IdentitySourceConsumerReference['receipt'],
  context: HistoryReceivingContext,
  receiving?: Readonly<{ client: WorkClient; original: AgentIdentityOriginal; barrier: HistoryBarrier }>,
): Promise<string | null> {
  historyDeadline(context, 0);
  if (receiving) {
    if (
      receipt.kind !== receiving.original.key.direction ||
      receipt.account !== receiving.original.key.accountId ||
      receipt.receipt !== receiving.original.key.receiptId
    )
      return 'identity-sdk-source-native-binding-changed';
    const result = await readAgentIdentitySDKRetirement(
      pool,
      receiving.client,
      receiving.original,
      receiving.barrier,
      context,
    );
    return result.state === 'pending' ? result.gap : null;
  }
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.sourceMappingSnapshot, context);
  return identityHistoryConnection(pool, context, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      const row = (
        await tx.query('SELECT custody_id FROM core.agent_identity_work WHERE source_key=$1', [
          agentIdentityWorkSourceKey(receipt),
        ])
      ).rows[0];
      const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
      const mapping = row ? await resolveAgentIdentitySDKWork(tx, row.custody_id) : null;
      historyDeadline(context, 0);
      await tx.query('COMMIT');
      return (
        mapping?.gap ?? (mapping ? AGENT_IDENTITY_SDK_RETIREMENT.gap : 'agent-identity-sdk-recording-port-unavailable')
      );
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

export type AgentIdentitySDKRetirementObservation =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'received'; gap: null; receipt: AgentIdentitySDKRetirementReceipt }>;

/** Exact released observation of ONE original SDK receiving copy. The native SDK is
 * independently re-read before and after the ordinary physical receiving proof. This is
 * not a certificate for a later source command, a Source disposition or an Account root. */
export async function readAgentIdentitySDKRetirement(
  pool: Pool,
  client: WorkClient,
  original: AgentIdentityOriginal,
  barrier: HistoryBarrier,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKRetirementObservation> {
  const fixed = structuredClone(original);
  const fixedBarrier = structuredClone(barrier);
  agentIdentitySourceKey(fixed.key);
  if (fixed.partition !== partitionOf(fixed.key.route)) return pending('identity-sdk-source-native-binding-changed');
  const receipt = { kind: fixed.key.direction, account: fixed.key.accountId, receipt: fixed.key.receiptId };
  const sourceKey = agentIdentityWorkSourceKey(receipt);
  historyDeadline(context, 0);
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.retirementSnapshot, context);
  const saved = await identityHistoryConnection(pool, context, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      const row = (
        await tx.query<{
          custody_id: string;
          request_digest: Buffer | null;
          sdk_retirement_receipt: AgentIdentitySDKRetirementReceipt | null;
          state: string | null;
          owner_ready: boolean | null;
          absence_verified: boolean | null;
          payload_cleared: boolean;
        }>(
          `SELECT m.custody_id,m.request_digest,m.sdk_retirement_receipt,
             w.state,w.owner_ready,w.absence_verified,(w.request IS NULL AND w.scope IS NULL) AS payload_cleared
           FROM core.agent_identity_work m LEFT JOIN core.history_work w
             ON w.partition_no=0 AND w.work_id=m.custody_id
               AND w.owner='access.agent-identity' AND w.request_digest=m.request_digest
           WHERE m.source_key=$1`,
          [sourceKey],
        )
      ).rows[0];
      const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
      const mapping = row ? await resolveAgentIdentitySDKWork(tx, row.custody_id) : null;
      historyDeadline(context, 0);
      await tx.query('COMMIT');
      return { row, mapping };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  const { row, mapping } = saved;
  if (!row || !mapping) return pending('agent-identity-sdk-recording-port-unavailable');
  if (mapping.gap) return pending(mapping.gap);
  const source = mapping.source;
  if (
    !source ||
    source.key !== sourceKey ||
    source.partition !== fixed.partition ||
    source.epoch !== fixed.epoch ||
    source.position !== fixed.position.toString() ||
    source.transactionId !== fixed.transactionId ||
    source.digest !== fixed.digest
  )
    return pending('identity-sdk-source-native-binding-changed');
  const bound = row.sdk_retirement_receipt;
  if (!bound) return pending(AGENT_IDENTITY_SDK_RETIREMENT.gap);
  if (
    bound.binding.custodyId !== row.custody_id ||
    bound.binding.workflowId !== mapping.workflowId ||
    bound.binding.requestDigest !== row.request_digest?.toString('hex') ||
    !same(bound.binding.source, source) ||
    !same(bound.binding.barrier, fixedBarrier)
  )
    return pending('identity-sdk-retirement-receiving-binding-changed');
  const before = await readAgentIdentitySDKFence(pool, client, bound, context);
  if (before.state === 'pending') return before;
  if (row.state !== 'retired' || !row.owner_ready || !row.absence_verified || !row.payload_cleared)
    return pending('identity-sdk-physical-receiving-pending');
  const { readAgentIdentityReceivingArtifact } = await import('./agent-identity-sdk-fence.ts');
  const artifact = await readAgentIdentityReceivingArtifact(pool, row.custody_id, context);
  if (!artifact) return pending('identity-sdk-physical-inventory-unavailable');
  if (!(await readHistoryReceivingReceipt({ pool }, fixedBarrier, artifact, context)))
    return pending('identity-sdk-physical-receiving-pending');
  const after = await readAgentIdentitySDKFence(pool, client, bound, context);
  if (after.state === 'pending') return after;
  historyDeadline(context, 0);
  return { state: 'received', gap: null, receipt: after.receipt };
}

// Semantic composes this Accounts-owned subdeclaration with its real reached terms.
export { IDENTITY_HISTORY_ACCOUNTS_DECLARATION } from './agent-identity-inventory-work.ts';
