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
import {
  currentIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
} from '../semantic/identity-source-consumer-maintenance.ts';
import type { AgentIdentityWorkSource } from './agent-identity-source.ts';
import type { AgentIdentityRetirementStage } from './agent-identity-retirement.ts';
import { encodeLocator } from './locator.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';

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

/** The current Source verifier has no native durable History handoff interface. A released
 * true result cannot authorize either readiness or final receiving closure. */
export const IDENTITY_HISTORY_HANDOFF_UNAVAILABLE = 'identity-source-history-durable-handoff-unavailable';

export const AGENT_IDENTITY_SDK_OBSERVATION_COST = Object.freeze({
  rows: 3,
  points: 2,
  statements: 1,
  bytes: 8192,
  engineRequests: 0,
});
export type AgentIdentitySDKWriterObservation = Pending | Readonly<{ state: 'observed'; writer: SdkWriterState }>;

/** Released observation, independently funded in the SAME live Source frame. This never
 * creates a workflow identity and is not authority for a later command. */
export async function readAgentIdentitySDKWriterState(
  pool: Pool,
  client: WorkClient,
  workflowId: string,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKWriterObservation> {
  historyDeadline(context, 0);
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const work = currentIdentitySourceConsumerMaintenance(pool, context.deadline);
  if (!work || !reserveIdentitySourceConsumerNativeWork(pool, work, AGENT_IDENTITY_SDK_OBSERVATION_COST))
    return pending('identity-sdk-current-fence-funding-unavailable');
  const writer = await readSdkWorkflowWriterState(workflowId, client);
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
  if (currentCommand(tx).basis !== null) throw new TypeError('Identity SDK fence requires a current native command');
  historyDeadline(resources, currentCommand(tx).partition);
  if (expected.workflowID !== workflowId) return pending('identity-sdk-original-writer-changed');
  if (phase === 'closure' && expected.generation !== '2') return pending('identity-sdk-permanent-closure-pending');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const work = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  if (
    !work ||
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
    return { state: 'observed', writer: await lockSdkWorkflowWriterState(tx, expected, client) };
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
      `SELECT m.source,m.accounts,m.request_digest,m.receiver_epoch,m.receiver_generation::text
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
  return (
    await runCommand(pool, { partition: 0, deadline: context.deadline }, async (tx) =>
      noEffect(
        await readAgentIdentitySDKReceivingBinding(
          tx,
          {
            partition: 0,
            locator: { artifactType: 'durable-work/v1', workId: binding.custodyId },
            accounts: binding.source.accounts,
          },
          binding.barrier,
        ),
      ),
    )
  ).value;
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
  const fixed = structuredClone(receipt);
  if (fixed.sourceGeneration !== fixed.binding.receiver.generation)
    return pending('identity-sdk-retirement-source-fence-changed');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const before = await receivingBinding(pool, fixed.binding, context);
  if (before.state === 'pending') return before;
  if (!same(before.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  historyDeadline(context, 0);
  const fence = await readSdkWorkflowRetirement(fixed.binding.workflowId, client);
  if (!validFence(fence, fixed.binding.workflowId) || !same(fence, fixed.fence))
    return pending('identity-sdk-native-receipt-changed');
  const after = await receivingBinding(pool, fixed.binding, context);
  if (after.state === 'pending') return after;
  if (!same(after.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  return { state: 'observed', receipt: { ...fixed, fence } };
}

/** Stage the actual original owners for readiness, without retiring a live obligation.
 * Current Source custody and the SDK fence serialize in the same Source command. The
 * absent native durable handoff remains pending before any readiness/retirement write. */
export async function retireAgentIdentitySDKWork(
  pool: Pool,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  context: HistoryReceivingContext,
): Promise<AgentIdentitySDKFenceObservation> {
  const fixed: AgentIdentityRetirementStage = {
    reference: structuredClone(stage.reference),
    handoff: structuredClone(stage.handoff),
    consumer: stage.consumer,
  };
  const { verifyAgentIdentityRetirementStage } = await import('./agent-identity-retirement.ts');
  const sourceCheck = async () => {
    historyDeadline(context, fixed.reference.source.partition);
    return (
      await runCommand(pool, { partition: fixed.reference.source.partition, deadline: context.deadline }, async (tx) =>
        noEffect(await verifyAgentIdentityRetirementStage(tx, fixed)),
      )
    ).value;
  };
  const source = await sourceCheck();
  if (source.state === 'pending') return source;
  historyDeadline(context, 0);
  const receiver = (
    await runCommand(pool, { partition: 0, deadline: context.deadline }, async (tx) =>
      noEffect(
        await readAgentIdentitySDKReceivingBinding(
          tx,
          {
            partition: 0,
            locator: { artifactType: 'durable-work/v1', workId: fixed.handoff.custodyId },
            accounts: fixed.handoff.source.accounts,
          },
          fixed.reference.barrier,
        ),
      ),
    )
  ).value;
  if (receiver.state === 'pending') return receiver;
  if (
    source.custodyId !== receiver.binding.custodyId ||
    source.workflowId !== receiver.binding.workflowId ||
    !same(receiver.binding.source, fixed.handoff.source) ||
    receiver.binding.receiver.generation !== fixed.handoff.generation
  )
    return pending('identity-sdk-retirement-source-fence-changed');
  const observed = await readAgentIdentitySDKWriterState(pool, client, receiver.binding.workflowId, context);
  if (observed.state === 'pending') return observed;
  // Re-enter the actual Source command. Source and SDK current locks now survive the
  // SAME commit; no released verifier result or independently checked-out SDK supplies it.
  historyDeadline(context, fixed.reference.source.partition);
  return (
    await runCommand<AgentIdentitySDKFenceObservation>(
      pool,
      { partition: fixed.reference.source.partition, deadline: context.deadline },
      async (tx) => {
        const current = await verifyAgentIdentityRetirementStage(tx, fixed);
        if (current.state === 'pending') return noEffect(current);
        if (!same(current, source)) return noEffect(pending('identity-sdk-retirement-source-fence-changed'));
        const writer = await lockAgentIdentitySDKWriterState(
          tx,
          client,
          current.workflowId,
          observed.writer,
          'readiness',
        );
        if (writer.state === 'pending') return noEffect(writer);
        // The original History database guard has no supported Source-owner native
        // handoff to consume. Do not retire the SDK while its live obligation is still
        // pending, persist a copied terminal receipt, or manufacture owner_ready.
        return noEffect(pending(IDENTITY_HISTORY_HANDOFF_UNAVAILABLE));
      },
    )
  ).value;
}
