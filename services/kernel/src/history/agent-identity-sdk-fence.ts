import canonicalize from 'canonicalize';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import {
  lockSdkWorkflowWriterState,
  readSdkWorkflowWriterState,
  readSdkWorkflowRetirement,
  type SdkRetirementFence as WorkflowWriterFence,
  type SdkRetirementClient,
  SDK_TRANSACTION_FENCE_COST,
  type SdkWriterState,
} from '../work/sdk-retirement-fence.ts';
import type { AgentIdentityWorkSource } from './agent-identity-source.ts';
import type { AgentIdentityRetirementStage } from './agent-identity-retirement.ts';
import { partitionOf } from '../route/route.ts';
import { encodeLocator } from './locator.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import { unpricedIdentityHistoryWork, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK } from './agent-identity-inventory-work.ts';

/** Published producer vocabulary. Availability is checked on the genuine runtime client;
 * a source declaration does not prove migration coverage or grant source discharge. */
export const AGENT_IDENTITY_SDK_FENCE_CONSUMER = Object.freeze({
  binding: 'access.agent-identity.sdk-retirement/v1',
  nativeAPI: ['retireWorkflow', 'getWorkflowWriterFence'],
  nativeReceipt: ['workflowID', 'generation', 'closureID', 'closedAt'],
  gap: 'identity-source-terminal-transfer-unavailable',
} as const);

/** Exact receiving request binding. This is metadata, never cleanup permission. */
export type AgentIdentitySDKReceivingBinding = Readonly<{
  kind: typeof AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding;
  custodyId: string;
  workflowId: string;
  requestDigest: string;
  source: AgentIdentityWorkSource;
  receiver: Readonly<{ partition: 0; epoch: number; generation: string; writerVersion: 1 }>;
  barrier: HistoryBarrier;
}>;
type Pending = Readonly<{ state: 'pending'; gap: string }>;
export type AgentIdentitySDKReceivingObservation =
  | Pending
  | Readonly<{ state: 'observed'; binding: AgentIdentitySDKReceivingBinding }>;

const pending = (gap: string): Pending => ({ state: 'pending', gap });
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

/** A released check or copied SDK receipt cannot authorize native History readiness. */
export const IDENTITY_HISTORY_HANDOFF_UNAVAILABLE = 'identity-source-history-durable-handoff-unavailable';

export const AGENT_IDENTITY_SDK_OBSERVATION_COST = Object.freeze({
  rows: 3,
  points: 2,
  statements: 1,
  bytes: 8192,
  engineRequests: 0,
});

// Original mapping's three point reads and the full LIMIT65 physical role union.
// This is additional to the command controls and to each reached receiving validator.
export const AGENT_IDENTITY_RECEIVING_ARTIFACT_COST = Object.freeze({
  rows: 69,
  points: 69,
  statements: 4,
  bytes: 24576,
  engineRequests: 0,
});

/** Released physical inventory observation. Pay its complete local body before acquiring
 * the receiving checkout; the returned address and roles still confer no cleanup custody. */
export async function readAgentIdentityReceivingArtifact(
  pool: Pool,
  custodyId: string,
  context: HistoryReceivingContext,
): Promise<HistoryArtifact | null> {
  historyDeadline(context, 0);
  const { identityHistoryCommand, reserveIdentityHistoryWork } = await import('./agent-identity-inventory-work.ts');
  await reserveIdentityHistoryWork(pool, AGENT_IDENTITY_RECEIVING_ARTIFACT_COST, context);
  return identityHistoryCommand(pool, context, (tx) => lockAgentIdentityReceivingArtifact(tx, custodyId));
}

export type AgentIdentitySDKWriterObservation = Pending | Readonly<{ state: 'observed'; writer: SdkWriterState }>;

/** Released observation, independently funded in the SAME live Source frame. This never
 * creates a workflow identity and is not authority for a later command. */
export async function readAgentIdentitySDKWriterState(
  pool: Pool,
  client: WorkClient,
  workflowId: string,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKWriterObservation> {
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(pool, context, client);
  historyDeadline(context, 0);
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  // The maintenance owner depends on HTTP/Library construction. Load it only at the
  // actual operation boundary, as Source staging does, to avoid an eager kernel cycle.
  const { currentIdentitySourceConsumerMaintenance, reserveIdentitySourceConsumerNativeWork } =
    await import('../semantic/identity-source-consumer-maintenance.ts');
  const work = currentIdentitySourceConsumerMaintenance(pool, context.deadline);
  if (
    !work ||
    (context.identityConsumerWork !== undefined && context.identityConsumerWork !== work) ||
    !reserveIdentitySourceConsumerNativeWork(pool, work, AGENT_IDENTITY_SDK_OBSERVATION_COST)
  )
    return pending('identity-sdk-current-fence-funding-unavailable');
  history.assertAgentIdentityHistoryUnit(pool, context, client);
  const writer = await readSdkWorkflowWriterState(workflowId, client);
  history.assertAgentIdentityHistoryUnit(pool, context, client);
  historyDeadline(context, 0);
  return writer ? { state: 'observed', writer } : pending('identity-sdk-original-writer-unavailable');
}

/** Technical current-state check only. The SDK derives physical placement from the actual
 * command pool, and owns both native locks until this command commits. Generation 1 may
 * serialize readiness; only the exact generation-2 tuple may serialize closure. A database
 * error propagates: its transaction must roll back, never continue after a stale check. */
export async function lockAgentIdentitySDKWriterState(
  tx: CommandTransaction,
  client: WorkClient,
  workflowId: string,
  expected: SdkWriterState,
  phase: 'readiness' | 'closure',
): Promise<AgentIdentitySDKWriterObservation> {
  const resources = currentCommandResources(tx);
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(resources.pool, resources, client);
  if (currentCommand(tx).basis !== null) throw new TypeError('Identity SDK fence requires a current native command');
  historyDeadline(resources, currentCommand(tx).partition);
  if (expected.workflowID !== workflowId) return pending('identity-sdk-original-writer-changed');
  if (phase === 'closure' && expected.generation !== '2') return pending('identity-sdk-permanent-closure-pending');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const { currentIdentitySourceConsumerMaintenance, reserveIdentitySourceConsumerNativeWork } =
    await import('../semantic/identity-source-consumer-maintenance.ts');
  const work = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  if (!work) return pending('identity-sdk-current-fence-funding-unavailable');
  if (history.currentAgentIdentityHistoryUnit()?.prepaid) {
    const { reserveIdentityHistoryWork } = await import('./agent-identity-inventory-work.ts');
    await reserveIdentityHistoryWork(resources.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.sdkWriterLock, resources);
  } else if (
    !reserveIdentitySourceConsumerNativeWork(resources.pool, work, {
      rows: SDK_TRANSACTION_FENCE_COST.rows,
      points: SDK_TRANSACTION_FENCE_COST.points,
      statements: SDK_TRANSACTION_FENCE_COST.statements,
      bytes: SDK_TRANSACTION_FENCE_COST.bytes,
      engineRequests: SDK_TRANSACTION_FENCE_COST.engineWork,
    })
  )
    return pending('identity-sdk-current-fence-funding-unavailable');
  try {
    history.assertAgentIdentityHistoryUnit(resources.pool, resources, client);
    const writer = await lockSdkWorkflowWriterState(tx, expected, client);
    history.assertAgentIdentityHistoryUnit(resources.pool, resources, client);
    return { state: 'observed', writer };
  } catch (error) {
    // This is the SDK's specific pre-IO placement refusal, not a SQL error or retry.
    if (error instanceof Error && error.message === 'DBOS writer fence requires the same native transaction pool')
      return pending('identity-sdk-source-pool-mismatch');
    throw error;
  }
}

/** Receiver-local locks only. The caller releases its source checkout before entering.
 * Native UUID mapping, original SDK creation, restore/writer generation, physical roles
 * and the independent erasure barrier must agree before even describing the request. */
export async function readAgentIdentitySDKReceivingBinding(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<AgentIdentitySDKReceivingObservation> {
  if (currentCommand(tx).partition !== 0 || currentCommand(tx).basis !== null)
    throw new TypeError('Identity SDK fence requires its SAME receiving home');
  if (artifact.partition !== 0 || artifact.locator.artifactType !== 'durable-work/v1')
    return pending('identity-sdk-receiving-home-mismatch');
  // No receiving checkout can carry the live Account fence from a foreign home.
  if (partitionOf(barrier.accountRoute) !== 0) return pending('agent-identity-source-barrier-home-unavailable');
  const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
  const mapping = await resolveAgentIdentitySDKWork(tx, artifact.locator.workId);
  if (!mapping || mapping.gap) return pending(mapping?.gap ?? 'identity-sdk-native-binding-unavailable');
  const row = (
    await tx.query<{
      source: AgentIdentityWorkSource | null;
      accounts: HistoryArtifact['accounts'];
      request_digest: Buffer;
      receiver_epoch: number;
      receiver_generation: string;
    }>(
      `SELECT m.source,CASE WHEN octet_length(m.accounts::text)<=8192 THEN m.accounts END AS accounts,m.request_digest,m.receiver_epoch,m.receiver_generation::text
       FROM core.agent_identity_work m JOIN core.history_work w
         ON w.partition_no=0 AND w.work_id=m.custody_id AND w.owner='access.agent-identity'
         AND w.request_digest=m.request_digest
       WHERE m.custody_id=$1 FOR SHARE OF m,w`,
      [artifact.locator.workId],
    )
  ).rows[0];
  const roles = (
    await tx.query(
      `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
      [Buffer.from(encodeLocator(artifact.locator))],
    )
  ).rows;
  const accounts = roles.map((entry) => ({
    accountRoute: entry.account_route,
    accountId: entry.account_id,
    roles: entry.roles,
  }));
  if (
    !row?.source ||
    !roles.length ||
    roles.length > 64 ||
    roles.some((entry) => entry.minimizer_version !== 1) ||
    !same(row.accounts, accounts) ||
    !same(artifact.accounts, accounts) ||
    !accounts.some((entry) => entry.accountId === barrier.accountId && entry.accountRoute === barrier.accountRoute)
  )
    return pending('identity-sdk-retirement-role-scope-changed');
  if (!(await lockHistoryBarrier(tx, barrier))) return pending('identity-sdk-retirement-barrier-changed');
  return {
    state: 'observed',
    binding: {
      kind: AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding,
      custodyId: artifact.locator.workId,
      workflowId: mapping.workflowId,
      requestDigest: row.request_digest.toString('hex'),
      source: row.source,
      receiver: { partition: 0, epoch: row.receiver_epoch, generation: row.receiver_generation, writerVersion: 1 },
      barrier: { ...barrier },
    },
  };
}

/** First supported consumer receipt binding for Source and original-row minimization.
 * `fence` is the UNMODIFIED SDK receipt. The surrounding binding is Kernel metadata;
 * it supplies no Semantic terminal/undo locator and confers no cleanup authority. */
export type AgentIdentitySDKRetirementReceipt = Readonly<{
  binding: AgentIdentitySDKReceivingBinding;
  sourceGeneration: string;
  fence: WorkflowWriterFence;
}>;
export type AgentIdentitySDKFenceObservation =
  | Pending
  | Readonly<{ state: 'observed'; receipt: AgentIdentitySDKRetirementReceipt }>;

function nativeClient(client: WorkClient): client is WorkClient & SdkRetirementClient {
  return (
    client instanceof DBOSClient &&
    client.applicationName === WORK_APPLICATION &&
    'retireWorkflow' in client &&
    typeof client.retireWorkflow === 'function' &&
    'getWorkflowWriterFence' in client &&
    typeof client.getWorkflowWriterFence === 'function'
  );
}

function validFence(fence: WorkflowWriterFence | null, workflowId: string): fence is WorkflowWriterFence {
  return (
    fence !== null &&
    Object.keys(fence).sort().join(',') === 'closedAt,closureID,generation,workflowID' &&
    fence.workflowID === workflowId &&
    fence.generation === '2' &&
    typeof fence.closureID === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(fence.closureID) &&
    Number.isSafeInteger(fence.closedAt) &&
    fence.closedAt > 0
  );
}

async function receivingBinding(
  pool: Pool,
  binding: AgentIdentitySDKReceivingBinding,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKReceivingObservation> {
  historyDeadline(context, 0);
  const owner = await import('../semantic/identity-source-consumer-maintenance.ts');
  const { identityHistoryCommand, reserveIdentityHistoryWork, nativeWork } =
    await import('./agent-identity-inventory-work.ts');
  // A Source reference describes its roles, not the SDK copy's physical inventory.
  // Resolve that copy's complete current role union in this same receiving command.
  // This additional lookup is independent of the existing R reservation below.
  await reserveIdentityHistoryWork(pool, AGENT_IDENTITY_RECEIVING_ARTIFACT_COST, context);
  await reserveIdentityHistoryWork(pool, nativeWork(160, 80, 6, 131072), context);
  const read = async (tx: CommandTransaction): Promise<AgentIdentitySDKReceivingObservation> => {
    const artifact = await lockAgentIdentityReceivingArtifact(tx, binding.custodyId);
    if (!artifact) return pending('identity-sdk-physical-inventory-unavailable');
    return readAgentIdentitySDKReceivingBinding(tx, artifact, binding.barrier);
  };
  if (owner.currentIdentitySourceConsumerMaintenance(pool, context.deadline)) {
    return identityHistoryCommand(pool, context, read);
  }
  return (await runCommand(pool, { partition: 0, deadline: context.deadline }, async (tx) => noEffect(await read(tx))))
    .value;
}

/** Independently reread a previously bound receipt through the real SDK. This observation is
 * also required AFTER supported deletion. No source/receiver checkout spans the SDK call.
 * Receipt shape/equality proves neither writer guard installation nor source/root authority. */
export async function readAgentIdentitySDKFence(
  pool: Pool,
  client: WorkClient,
  receipt: AgentIdentitySDKRetirementReceipt,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKFenceObservation> {
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(pool, context, client);
  const fixed = structuredClone(receipt);
  if (fixed.sourceGeneration !== fixed.binding.receiver.generation)
    return pending('identity-sdk-retirement-source-fence-changed');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const before = await receivingBinding(pool, fixed.binding, context);
  if (before.state === 'pending') return before;
  if (!same(before.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  historyDeadline(context, 0);
  const { reserveIdentityHistoryWork, nativeWork } = await import('./agent-identity-inventory-work.ts');
  // Preserve inherited/explicit provenance across the released receiving await.
  // An ended frame is not an independently admitted SDK observation.
  await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 8192), context);
  const fence = await readSdkWorkflowRetirement(fixed.binding.workflowId, client);
  historyDeadline(context, 0);
  if (!validFence(fence, fixed.binding.workflowId) || !same(fence, fixed.fence))
    return pending('identity-sdk-native-receipt-changed');
  const after = await receivingBinding(pool, fixed.binding, context);
  if (after.state === 'pending') return after;
  if (!same(after.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  return { state: 'observed', receipt: { ...fixed, fence } };
}

/** Complete readiness -> released owner retirement -> exact closure recording.
 * Each command re-enters the original Source owner. Nothing here mints Source proof. */
export async function retireAgentIdentitySDKWork(
  pool: Pool,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKFenceObservation> {
  const {
    identityHistoryCommand,
    reserveIdentityHistoryWork,
    nativeWork,
    addNativeWork,
    HISTORY_WORK_INVALIDATION,
    HISTORY_WORK_WAKE,
  } = await import('./agent-identity-inventory-work.ts');
  const { maintainSdkWorkflowOnce, supportsBoundedSdkMaintenance } = await import('../work/sdk-retirement-fence.ts');
  // Preserve native source/role refusal before SDK dispatch, including legacy callers.
  const { verifyAgentIdentityRetirementStage, currentAgentIdentityHistoryUnit } =
    await import('./agent-identity-retirement.ts');
  const { IDENTITY_HISTORY_COMMAND_CONTROL } = await import('./agent-identity-inventory-work.ts');
  const prepaid = !!currentAgentIdentityHistoryUnit()?.prepaid;
  const verification = unpricedIdentityHistoryWork(
    'source-native-retirement-verification',
    nativeWork(71, 71, 19, 82048),
  );
  await reserveIdentityHistoryWork(
    pool,
    prepaid ? verification : addNativeWork(verification, IDENTITY_HISTORY_COMMAND_CONTROL),
    context,
  );
  const verify = (tx: CommandTransaction) => verifyAgentIdentityRetirementStage(tx, stage);
  const check = prepaid
    ? await identityHistoryCommand(pool, context, verify, stage.reference.source.partition)
    : (
        await runCommand(
          pool,
          { partition: stage.reference.source.partition, deadline: context.deadline },
          async (tx) => noEffect(await verify(tx)),
        )
      ).value;
  if (check.state === 'pending') return check;
  if (!nativeClient(client) || !supportsBoundedSdkMaintenance(client))
    return pending('identity-sdk-bounded-maintenance-not-installed');
  const receiver = await identityHistoryCommand(pool, context, async (tx) => {
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.sdkReceiving, context);
    return readAgentIdentitySDKReceivingBinding(
      tx,
      {
        partition: 0,
        locator: { artifactType: 'durable-work/v1', workId: stage.handoff.custodyId },
        accounts: stage.handoff.source.accounts,
      },
      stage.reference.barrier,
    );
  });
  if (receiver.state === 'pending') return receiver;
  if (
    receiver.binding.receiver.generation !== stage.handoff.generation ||
    !same(receiver.binding.source, stage.handoff.source)
  )
    return pending('identity-sdk-retirement-source-fence-changed');
  const observed = await readAgentIdentitySDKWriterState(pool, client, receiver.binding.workflowId, context);
  if (observed.state === 'pending') return observed;
  const recorded = await identityHistoryCommand(pool, context, async (tx) => {
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.previousReadiness, context);
    const saved = (
      await tx.query<{
        history_authority: AgentIdentityHistoryAuthority | null;
        sdk_readiness: AgentIdentityHistoryReadiness | null;
        sdk_closure: SdkWriterState | null;
      }>(
        `SELECT history_authority,sdk_readiness,sdk_closure FROM core.agent_identity_work WHERE custody_id=$1 FOR UPDATE`,
        [stage.handoff.custodyId],
      )
    ).rows[0];
    if (!saved) return pending('identity-sdk-native-binding-unavailable');
    const phase = observed.writer.generation === '1' ? 'readiness' : 'closure';
    if (phase === 'closure' && !saved.sdk_readiness) return pending('identity-history-original-readiness-missing');
    const held = await lockAgentIdentityHistoryHandoff(tx, client, stage, receiver.binding, observed.writer, phase);
    if (held.state === 'pending') return held;
    if (saved.sdk_readiness) {
      if (
        !same(saved.sdk_readiness.binding, receiver.binding) ||
        !same(saved.history_authority, held.handoff.sourceAuthority)
      )
        return pending('identity-history-current-authority-changed');
      return { state: 'recorded', readiness: saved.sdk_readiness } as const;
    }
    const readiness = { binding: held.handoff.binding, writer: held.handoff.writer };
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeWrite, AGENT_IDENTITY_HISTORY_GUARD_COST),
      context,
    );
    await tx.query(`UPDATE core.agent_identity_work SET history_authority=$2,sdk_readiness=$3 WHERE custody_id=$1`, [
      stage.handoff.custodyId,
      held.handoff.sourceAuthority,
      readiness,
    ]);
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativePairWrite,
        AGENT_IDENTITY_HISTORY_GUARD_COST,
        HISTORY_WORK_INVALIDATION,
        HISTORY_WORK_WAKE,
      ),
      context,
    );
    await tx.query(
      `UPDATE core.history_work SET owner_ready=true,state='ready' WHERE partition_no=0 AND work_id=$1 AND state='pending'`,
      [stage.handoff.custodyId],
    );
    return { state: 'recorded', readiness } as const;
  });
  if (recorded.state === 'pending') return recorded;
  // Read the actual committed readiness after releasing the Source transaction.
  const durable = await identityHistoryCommand(pool, context, async (tx) => {
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.durableReadiness, context);
    return (
      await tx.query<{ sdk_readiness: AgentIdentityHistoryReadiness | null }>(
        `SELECT sdk_readiness FROM core.agent_identity_work WHERE custody_id=$1 FOR SHARE`,
        [stage.handoff.custodyId],
      )
    ).rows[0];
  });
  if (!durable?.sdk_readiness || !same(durable.sdk_readiness, recorded.readiness))
    return pending('identity-history-original-readiness-changed');
  if (observed.writer.generation === '1') {
    if (!same(observed.writer, durable.sdk_readiness.writer)) return pending('identity-sdk-readiness-writer-changed');
    await maintainSdkWorkflowOnce(pool, client, durable.sdk_readiness.writer, 'retire', context.deadline, (cost) =>
      reserveIdentityHistoryWork(pool, cost, context),
    );
  }
  const closed = await readAgentIdentitySDKWriterState(pool, client, receiver.binding.workflowId, context);
  if (closed.state === 'pending') return closed;
  if (closed.writer.restoreGeneration !== durable.sdk_readiness.writer.restoreGeneration)
    return pending('identity-sdk-original-restore-generation-changed');
  if (closed.writer.generation !== '2' || !closed.writer.closureID || closed.writer.closedAt === null)
    return pending('identity-sdk-permanent-closure-pending');
  return identityHistoryCommand(pool, context, async (tx) => {
    const held = await lockAgentIdentityHistoryHandoff(tx, client, stage, receiver.binding, closed.writer, 'closure');
    if (held.state === 'pending') return held;
    const receipt: AgentIdentitySDKRetirementReceipt = {
      binding: receiver.binding,
      sourceGeneration: stage.handoff.generation,
      fence: {
        workflowID: closed.writer.workflowID,
        generation: '2',
        closureID: closed.writer.closureID!,
        closedAt: closed.writer.closedAt!,
      },
    };
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeAuthoritySeal, AGENT_IDENTITY_HISTORY_GUARD_COST),
      context,
    );
    await tx.query(`UPDATE core.agent_identity_work SET sdk_closure=$2,sdk_retirement_receipt=$3 WHERE custody_id=$1`, [
      stage.handoff.custodyId,
      closed.writer,
      receipt,
    ]);
    return { state: 'observed', receipt };
  });
}

/** Native expected address returned by the original Source producer. It is persisted
 * only after that producer has reconstructed and locked it, and re-resolved by the
 * original native function on every later History transition. */
export type AgentIdentityHistoryAuthority =
  import('../semantic/identity-source-consumer-custody.ts').IdentitySourceHistoryAuthority;
export type AgentIdentityHistoryReadiness = Readonly<{
  binding: AgentIdentitySDKReceivingBinding;
  writer: SdkWriterState;
}>;

/** Delegate to the installed Source producer's native handoff and authority type. */
export async function lockAgentIdentityHistoryHandoff(
  tx: CommandTransaction,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  binding: AgentIdentitySDKReceivingBinding,
  writer: SdkWriterState,
  phase: 'readiness' | 'closure',
) {
  const history = await import('./agent-identity-retirement.ts');
  const owner = await import('../semantic/identity-source-consumer-custody.ts');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  history.assertAgentIdentityHistoryUnit(currentCommandResources(tx).pool, currentCommandResources(tx), client);
  const answer = await owner.lockIdentitySourceHistoryHandoff(tx, stage, binding, writer, phase, client);
  history.assertAgentIdentityHistoryUnit(currentCommandResources(tx).pool, currentCommandResources(tx), client);
  return answer;
}

// Native check: m(1), partition/domain(2), work(1), bounded roles(65), aggregate(1),
// barrier(1), original Source wrapper/function(17), SDK current lock(4). Each physical role
// is charged as a visible key. The outer SELECT/write is charged separately.
export const AGENT_IDENTITY_HISTORY_GUARD_COST = unpricedIdentityHistoryWork(
  'source-native-history-guard',
  Object.freeze({
    rows: 92,
    points: 87,
    statements: 11,
    bytes: 40960,
    engineRequests: 0,
  }),
);
export const AGENT_IDENTITY_HISTORY_ABSENCE_COST = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeAbsence;

export async function lockRecordedAgentIdentityHistory(
  tx: CommandTransaction,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  context: HistoryReceivingContext,
): Promise<
  Pending | Readonly<{ state: 'guarded'; receipt: AgentIdentitySDKRetirementReceipt; writer: SdkWriterState }>
> {
  const { reserveIdentityHistoryWork, nativeWork, addNativeWork } = await import('./agent-identity-inventory-work.ts');
  const { pool, deadline } = currentCommandResources(tx);
  const { assertAgentIdentityHistoryUnit } = await import('./agent-identity-retirement.ts');
  assertAgentIdentityHistoryUnit(pool, context, client);
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.recordedAuthority, { deadline });
  const row = (
    await tx.query<{
      history_authority: AgentIdentityHistoryAuthority | null;
      sdk_readiness: AgentIdentityHistoryReadiness | null;
      sdk_closure: SdkWriterState | null;
      sdk_retirement_receipt: AgentIdentitySDKRetirementReceipt | null;
    }>(
      `SELECT history_authority,sdk_readiness,sdk_closure,sdk_retirement_receipt
      FROM core.agent_identity_work WHERE custody_id=$1 FOR SHARE`,
      [stage.handoff.custodyId],
    )
  ).rows[0];
  if (!row?.history_authority || !row.sdk_readiness || !row.sdk_closure || !row.sdk_retirement_receipt)
    return pending('identity-history-guarded-closure-pending');
  const held = await lockAgentIdentityHistoryHandoff(
    tx,
    client,
    stage,
    row.sdk_readiness.binding,
    row.sdk_closure,
    'closure',
  );
  if (held.state === 'pending') return held;
  if (!same(held.handoff.sourceAuthority, row.history_authority) || !same(held.handoff.writer, row.sdk_closure))
    return pending('identity-history-current-authority-changed');
  await reserveIdentityHistoryWork(
    pool,
    addNativeWork(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeGuardProbe, AGENT_IDENTITY_HISTORY_GUARD_COST),
    {
      deadline,
    },
  );
  await tx.query(`SELECT core.check_agent_identity_history($1,$2,$3,$4,'closure')`, [
    stage.handoff.custodyId,
    row.sdk_readiness.binding,
    row.history_authority,
    row.sdk_closure,
  ]);
  historyDeadline(context, 0);
  return { state: 'guarded', receipt: row.sdk_retirement_receipt, writer: row.sdk_closure };
}

/** Resolve an original mapped receiving execution using its native physical inventory.
 * Accounts come from the complete current locator union, never workflow/source metadata.
 * Callers reserve the bounded mapping/role reads before entry; nativeReceipt supplies
 * current barrier, generation-2, physical absence and later receiving verification.
 */
export async function lockAgentIdentityReceivingArtifact(
  tx: CommandTransaction,
  custodyId: string,
): Promise<HistoryArtifact | null> {
  const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
  const mapping = await resolveAgentIdentitySDKWork(tx, custodyId);
  if (!mapping || mapping.gap) return null;
  const locator = {
    artifactType: 'durable-work/v1' as const,
    workId: custodyId,
  };
  const rows = (
    await tx.query<{
      account_route: number;
      account_id: string;
      roles: number;
      minimizer_version: number;
    }>(
      `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
    WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1
    ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
      [Buffer.from(encodeLocator(locator))],
    )
  ).rows;
  if (rows.length === 0 || rows.length > 64 || rows.some((r) => r.minimizer_version !== 1)) return null;
  return {
    partition: 0,
    locator,
    accounts: rows.map((r) => ({
      accountRoute: r.account_route,
      accountId: r.account_id,
      roles: r.roles,
    })),
  };
}
