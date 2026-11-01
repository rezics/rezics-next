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

/** A released check or copied SDK receipt cannot authorize native History readiness. */
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
  // The maintenance owner depends on HTTP/Library construction. Load it only at the
  // actual operation boundary, as Source staging does, to avoid an eager kernel cycle.
  const { currentIdentitySourceConsumerMaintenance, reserveIdentitySourceConsumerNativeWork } =
    await import('../semantic/identity-source-consumer-maintenance.ts');
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
  const { currentIdentitySourceConsumerMaintenance, reserveIdentitySourceConsumerNativeWork } =
    await import('../semantic/identity-source-consumer-maintenance.ts');
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
  if (owner.currentIdentitySourceConsumerMaintenance(pool, context.deadline)) {
    const { identityHistoryCommand, reserveIdentityHistoryWork, nativeWork } =
      await import('./agent-identity-inventory-work.ts');
    await reserveIdentityHistoryWork(pool, nativeWork(160, 80, 6, 131072));
    return identityHistoryCommand(pool, context, (tx) =>
      readAgentIdentitySDKReceivingBinding(
        tx,
        {
          partition: 0,
          locator: { artifactType: 'durable-work/v1', workId: binding.custodyId },
          accounts: binding.source.accounts,
        },
        binding.barrier,
      ),
    );
  }
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
  const owner = await import('../semantic/identity-source-consumer-maintenance.ts');
  const work = owner.currentIdentitySourceConsumerMaintenance(pool, context.deadline);
  if (
    work &&
    !owner.reserveIdentitySourceConsumerNativeWork(pool, work, {
      rows: 1,
      points: 1,
      statements: 1,
      bytes: 8192,
      engineRequests: 0,
    })
  )
    return pending('identity-sdk-current-fence-funding-unavailable');
  const fence = await readSdkWorkflowRetirement(fixed.binding.workflowId, client);
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
  const { verifyAgentIdentityRetirementStage } = await import('./agent-identity-retirement.ts');
  const owner = await import('../semantic/identity-source-consumer-maintenance.ts');
  const live = owner.currentIdentitySourceConsumerMaintenance(pool, context.deadline);
  if (live) {
    const { IDENTITY_HISTORY_COMMAND_CONTROL } = await import('./agent-identity-inventory-work.ts');
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(nativeWork(71, 71, 19, 82048), IDENTITY_HISTORY_COMMAND_CONTROL),
    );
  }
  const check = (
    await runCommand(pool, { partition: stage.reference.source.partition, deadline: context.deadline }, async (tx) =>
      noEffect(await verifyAgentIdentityRetirementStage(tx, stage)),
    )
  ).value;
  if (check.state === 'pending') return check;
  if (!nativeClient(client) || !supportsBoundedSdkMaintenance(client))
    return pending('identity-sdk-bounded-maintenance-not-installed');
  const receiver = await identityHistoryCommand(pool, context, async (tx) => {
    await reserveIdentityHistoryWork(pool, nativeWork(160, 80, 6, 131072));
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
    await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 106496));
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
    await reserveIdentityHistoryWork(pool, addNativeWork(nativeWork(1, 1, 1, 0), AGENT_IDENTITY_HISTORY_GUARD_COST));
    await tx.query(`UPDATE core.agent_identity_work SET history_authority=$2,sdk_readiness=$3 WHERE custody_id=$1`, [
      stage.handoff.custodyId,
      held.handoff.sourceAuthority,
      readiness,
    ]);
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        nativeWork(2, 2, 2, 0),
        AGENT_IDENTITY_HISTORY_GUARD_COST,
        HISTORY_WORK_INVALIDATION,
        HISTORY_WORK_WAKE,
      ),
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
    await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 65536));
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
      reserveIdentityHistoryWork(pool, cost),
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
    await reserveIdentityHistoryWork(pool, addNativeWork(nativeWork(3, 3, 2, 0), AGENT_IDENTITY_HISTORY_GUARD_COST));
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
export type AgentIdentityHistoryAuthority = Readonly<Record<string, unknown>>;
export type AgentIdentityHistoryReadiness = Readonly<{
  binding: AgentIdentitySDKReceivingBinding;
  writer: SdkWriterState;
}>;

type SourceHistoryOwner = {
  lockIdentitySourceHistoryHandoff(
    tx: CommandTransaction,
    stage: AgentIdentityRetirementStage,
    binding: AgentIdentitySDKReceivingBinding,
    expected: SdkWriterState,
    phase: 'readiness' | 'closure',
    sdk: DBOSClient,
  ): Promise<
    | Pending
    | Readonly<{
        state: 'guarded';
        handoff: Readonly<{
          sourceAuthority: AgentIdentityHistoryAuthority;
          binding: AgentIdentitySDKReceivingBinding;
          writer: SdkWriterState;
        }>;
      }>
  >;
};

/** Agreed producer port, removed from optional admission when Source is installed.
 * An uninstalled producer is refused before History SQL, never emulated locally. */
export async function lockAgentIdentityHistoryHandoff(
  tx: CommandTransaction,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  binding: AgentIdentitySDKReceivingBinding,
  writer: SdkWriterState,
  phase: 'readiness' | 'closure',
) {
  const owner =
    (await import('../semantic/identity-source-consumer-custody.ts')) as unknown as Partial<SourceHistoryOwner>;
  if (!owner.lockIdentitySourceHistoryHandoff) return pending('identity-source-history-owner-not-installed');
  if (!nativeClient(client)) return pending('identity-sdk-native-client-unavailable');
  return owner.lockIdentitySourceHistoryHandoff(tx, stage, binding, writer, phase, client);
}

// Native check: m(1), partition/domain(2), work(1), bounded roles(65), aggregate(1),
// barrier(1), original Source function(16), SDK current lock(4). Each physical role
// is charged as a visible key. The outer SELECT/write is charged separately.
export const AGENT_IDENTITY_HISTORY_GUARD_COST = Object.freeze({
  rows: 92,
  points: 87,
  statements: 11,
  bytes: 40960,
  engineRequests: 0,
});
export const AGENT_IDENTITY_HISTORY_ABSENCE_COST = Object.freeze({
  rows: 9,
  points: 9,
  statements: 9,
  bytes: 0,
  engineRequests: 0,
});

export async function lockRecordedAgentIdentityHistory(
  tx: CommandTransaction,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  context: HistoryReceivingContext,
): Promise<
  Pending | Readonly<{ state: 'guarded'; receipt: AgentIdentitySDKRetirementReceipt; writer: SdkWriterState }>
> {
  const { reserveIdentityHistoryWork, nativeWork, addNativeWork } = await import('./agent-identity-inventory-work.ts');
  const { pool } = currentCommandResources(tx);
  await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 122880));
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
  await reserveIdentityHistoryWork(pool, addNativeWork(nativeWork(1, 0, 1, 256), AGENT_IDENTITY_HISTORY_GUARD_COST));
  await tx.query(`SELECT core.check_agent_identity_history($1,$2,$3,$4,'closure')`, [
    stage.handoff.custodyId,
    row.sdk_readiness.binding,
    row.history_authority,
    row.sdk_closure,
  ]);
  historyDeadline(context, 0);
  return { state: 'guarded', receipt: row.sdk_retirement_receipt, writer: row.sdk_closure };
}
