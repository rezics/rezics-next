import canonicalize from 'canonicalize';
import { existsSync } from 'node:fs';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
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

/** Type-only adapter for the original producer module while producer-first integration is
 * pending. These are exactly its published types, not another SDK extension or runtime shim.
 * Once integrated, the original wrapper is loaded and receives this actual WorkClient. */
type WorkflowWriterFence = Readonly<{
  workflowID: string;
  generation: string;
  closureID: string;
  closedAt: number;
}>;
type SdkRetirementClient = {
  retireWorkflow(workflowID: string): Promise<WorkflowWriterFence>;
  getWorkflowWriterFence(workflowID: string): Promise<WorkflowWriterFence | null>;
};
type SdkRetirementModule = {
  retireSdkWorkflowWriters(id: string, sdk: SdkRetirementClient): Promise<WorkflowWriterFence>;
  readSdkWorkflowRetirement(id: string, sdk: SdkRetirementClient): Promise<WorkflowWriterFence | null>;
};

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

async function nativeModule(): Promise<SdkRetirementModule | null> {
  // Resolve only the original producer path. Do not recreate its wrappers when absent, and
  // do not catch a broken installed module as if it were an unsupported SDK.
  const path = new URL('../work/sdk-retirement-fence.ts', import.meta.url);
  if (!existsSync(path)) return null;
  const module: SdkRetirementModule = await import(path.href);
  return typeof module.retireSdkWorkflowWriters === 'function' && typeof module.readSdkWorkflowRetirement === 'function'
    ? module
    : null;
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
  const sdk = await nativeModule();
  if (!sdk) return pending('identity-sdk-native-wrapper-unavailable');
  const before = await receivingBinding(pool, fixed.binding, context);
  if (before.state === 'pending') return before;
  if (!same(before.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  historyDeadline(context, 0);
  const fence = await sdk.readSdkWorkflowRetirement(fixed.binding.workflowId, client);
  if (!validFence(fence, fixed.binding.workflowId) || !same(fence, fixed.fence))
    return pending('identity-sdk-native-receipt-changed');
  const after = await receivingBinding(pool, fixed.binding, context);
  if (after.state === 'pending') return after;
  if (!same(after.binding, fixed.binding)) return pending('identity-sdk-retirement-receiving-binding-changed');
  return { state: 'observed', receipt: { ...fixed, fence } };
}

/** Source verification releases its home before receiver admission or SDK retirement.
 * The source verifier currently refuses until its owning durable terminal/undo transfer is
 * delivered. Neither the public boolean, an SDK receipt nor this entry point bypasses it. */
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
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  const sdk = await nativeModule();
  if (!sdk) return pending('identity-sdk-native-wrapper-unavailable');
  historyDeadline(context, 0);
  const fence = await sdk.retireSdkWorkflowWriters(receiver.binding.workflowId, client);
  if (!validFence(fence, receiver.binding.workflowId)) return pending('identity-sdk-native-receipt-invalid');
  const receipt = {
    binding: receiver.binding,
    sourceGeneration: fixed.handoff.generation,
    fence,
  };
  const observed = await readAgentIdentitySDKFence(pool, client, receipt, context);
  if (observed.state === 'pending') return observed;
  // Recheck the source on a released checkout. Persistence below captures only SDK evidence;
  // it cannot transition history_work or the source's future_writer_state to closed.
  const currentSource = await sourceCheck();
  if (currentSource.state === 'pending') return currentSource;
  if (!same(currentSource, source)) return pending('identity-sdk-retirement-source-fence-changed');
  return (
    await runCommand<AgentIdentitySDKFenceObservation>(
      pool,
      { partition: 0, deadline: context.deadline },
      async (tx) => {
        const current = await readAgentIdentitySDKReceivingBinding(
          tx,
          {
            partition: 0,
            locator: { artifactType: 'durable-work/v1', workId: receipt.binding.custodyId },
            accounts: receipt.binding.source.accounts,
          },
          receipt.binding.barrier,
        );
        if (current.state === 'pending') return noEffect(current);
        if (!same(current.binding, receipt.binding))
          return noEffect(pending('identity-sdk-retirement-receiving-binding-changed'));
        const row = (
          await tx.query<{ sdk_retirement_receipt: AgentIdentitySDKRetirementReceipt | null }>(
            'SELECT sdk_retirement_receipt FROM core.agent_identity_work WHERE custody_id=$1 FOR UPDATE',
            [receipt.binding.custodyId],
          )
        ).rows[0];
        if (!row || (row.sdk_retirement_receipt && !same(row.sdk_retirement_receipt, receipt)))
          return noEffect(pending('identity-sdk-native-receipt-changed'));
        if (!row.sdk_retirement_receipt)
          await tx.query('UPDATE core.agent_identity_work SET sdk_retirement_receipt=$2 WHERE custody_id=$1', [
            receipt.binding.custodyId,
            receipt,
          ]);
        return noEffect(observed);
      },
    )
  ).value;
}
