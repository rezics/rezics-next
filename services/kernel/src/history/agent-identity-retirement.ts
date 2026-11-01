import type {
  IdentitySourceConsumerCustody,
  IdentitySourceConsumerReference,
} from '../semantic/identity-source-consumer-custody.ts';
import canonicalize from 'canonicalize';
import { existsSync } from 'node:fs';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkClient } from '../work/client.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
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
  const path = new URL('../semantic/identity-source-consumer-maintenance.ts', import.meta.url);
  if (!existsSync(path)) return IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE;
  const producer: IdentitySourceConsumerMaintenanceModule = await import(path.href);
  if (typeof producer.withIdentitySourceConsumerMaintenance !== 'function')
    return IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE;
  let entered = false;
  try {
    return await producer.withIdentitySourceConsumerMaintenance(
      { pool: deps.pool, env: deps.env, ...(deps.clock === undefined ? {} : { clock: deps.clock }) },
      context,
      async (funded) => {
        entered = true;
        maintenanceCallbacks.add(funded);
        try {
          // The original accepted lookup also observes this unit's unchanged deadline.
          return await withRequestDeadline(funded.deadline, async () => {
            historyDeadline(funded, artifact.partition);
            const receiving = (
              await runCommand(deps.pool, { partition: 0, deadline: funded.deadline }, async (tx) =>
                noEffect(await readAgentIdentitySDKReceivingBinding(tx, artifact, barrier)),
              )
            ).value;
            if (receiving.state === 'pending') return receiving.gap;
            const source = receiving.binding.source;
            const receipt = sourceReceipt(source);
            if (!receipt) return 'identity-sdk-source-native-binding-changed';
            const { readAccountIdentitySource } = await import('../access/agent-verification-identity.ts');
            const native = (
              await runCommand(deps.pool, { partition: source.partition, deadline: funded.deadline }, async (tx) =>
                noEffect(await readAccountIdentitySource(tx, receipt, undefined, true)),
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
            const { retireAgentIdentitySDKWork } = await import('./agent-identity-sdk-fence.ts');
            const verified = await retireAgentIdentitySDKWork(deps.pool, deps.client, stage, funded);
            return verified.state === 'pending' ? verified.gap : null;
          });
        } finally {
          maintenanceCallbacks.delete(funded);
        }
      },
    );
  } catch (error) {
    // Exact provisional producer refusal. Callback/control failures propagate with their
    // real spent work; never retry or open another allocation inside this invocation.
    if (!entered && error instanceof Error && error.message === 'Identity Source maintenance funding is unavailable')
      return IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE;
    throw error;
  }
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
  const handoff = (
    await runCommand(pool, { partition: fixed.source.partition, deadline: context.deadline }, async (tx) =>
      noEffect(await sourceHandoff(tx, fixed)),
    )
  ).value;
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
  // A copied SDK receipt never establishes the distinct pre-retirement transition.
  // Keep the native guard closed until the Source owner can authorize that transition
  // on original History ownership. Generation 2 and physical receiving closure follow it.
  return { ready: false, gap: IDENTITY_HISTORY_HANDOFF_UNAVAILABLE };
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
  return withConnection(pool, async (tx) => {
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
  const saved = await withConnection(pool, async (tx) => {
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
  const artifact: HistoryArtifact = {
    partition: 0,
    locator: { artifactType: 'durable-work/v1', workId: row.custody_id },
    accounts: source.accounts,
  };
  if (!(await readHistoryReceivingReceipt({ pool }, fixedBarrier, artifact, context)))
    return pending('identity-sdk-physical-receiving-pending');
  const after = await readAgentIdentitySDKFence(pool, client, bound, context);
  if (after.state === 'pending') return after;
  historyDeadline(context, 0);
  return { state: 'received', gap: null, receipt: after.receipt };
}
