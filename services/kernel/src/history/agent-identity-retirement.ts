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
  type AgentIdentityReceipt,
  type AgentIdentityWorkSource,
} from './agent-identity-source.ts';
import { AGENT_IDENTITY_SDK_FENCE_CONSUMER, readAgentIdentitySDKReceivingBinding } from './agent-identity-sdk-fence.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryReadiness } from './registry.ts';
import sourceSelect from './agent-identity-retirement-source.sql';

/** Declaration-only adapter from the original producer's published module. Replace with
 * original type aliases when semantic/identity-source-consumer-maintenance.ts is integrated.
 * There is no local issuer, allocation or runtime substitute for that module. */
declare const identitySourceConsumerMaintenance: unique symbol;
export type IdentitySourceConsumerMaintenanceWork = Readonly<{
  [identitySourceConsumerMaintenance]: true;
}>;
export type IdentitySourceConsumerMaintenanceContext = Readonly<{
  deadline: number;
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerMaintenanceModule = {
  withIdentitySourceConsumerMaintenance<T>(
    deps: Readonly<{
      pool: Pool;
      env: Readonly<Record<string, string | undefined>>;
      clock?: KernelClock;
    }>,
    context: Readonly<{ deadline: number }>,
    body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
  ): Promise<T>;
};

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

/** The SDK producer supplies technical closure. Semantic durable source discharge remains
 * a separate prerequisite; no SDK receipt can authorize retirement of a live consumer. */
export const AGENT_IDENTITY_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.4.6-preview',
  futureWriters: 'native-sdk-fence-requires-source-transfer',
  gap: AGENT_IDENTITY_SDK_FENCE_CONSUMER.gap,
} as const);

const pending = (gap: string): AgentIdentityRetirementResult => ({ state: 'pending', gap });
const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
// Only contexts delivered to the actual producer callback may dispatch this caller's
// Source staging. This tracks the call site, not funding validity or Source authority;
// the producer still owns validation, accounting and invalidation of its opaque work.
const maintenanceCallbacks = new WeakSet<HistoryReceivingContext>();

export const IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE = 'identity-source-maintenance-funding-unavailable';

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
): Promise<string> {
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
            // A public verifier/SDK observation cannot supply the missing terminal transfer.
            return verified.state === 'pending' ? verified.gap : AGENT_IDENTITY_SDK_RETIREMENT.gap;
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
 * publication and technical-undo probes; no receiver/source transaction is held during them.
 * Its currently null proof is intentionally carried as pending, retaining every byte. */
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
 * generation/restore/writer and native Semantic proof in this SAME source transaction.
 * No foreign reads occur here. A true public verifier alone still cannot supply the missing
 * durable terminal/technical-undo transfer locator or permanent SDK writer fence. */
export async function verifyAgentIdentityRetirementStage(
  tx: CommandTransaction,
  stage: AgentIdentityRetirementStage,
): Promise<AgentIdentityRetirementResult> {
  if (currentCommand(tx).partition !== stage.reference.source.partition || currentCommand(tx).basis !== null)
    throw new TypeError('Identity retirement requires its SAME native source home');
  historyDeadline(currentCommandResources(tx), stage.reference.source.partition);
  if (!(await lockHistoryBarrier(tx, stage.reference.barrier)))
    return pending('identity-sdk-retirement-barrier-changed');
  const handoff = await sourceHandoff(tx, stage.reference);
  if (!handoff || !same(handoff, stage.handoff)) return pending('identity-sdk-retirement-source-fence-changed');
  const { verifyIdentitySourceConsumerCustody } = await import('../semantic/identity-source-consumer-custody.ts');
  if (!stage.consumer || !(await verifyIdentitySourceConsumerCustody(tx, stage.reference, stage.consumer)))
    return pending('identity-source-consumer-custody-pending');
  // The owning Semantic table currently admits only immutable `retained` receipts.
  // Neither that receipt nor the public verifier's return is a terminal transfer locator.
  return pending('identity-source-terminal-transfer-unavailable');
}

/** Receiver-local preconditions only. Never inspect a foreign source while holding this
 * transaction. Source retirement and SDK writer closure will each need durable native proof;
 * the durable source transfer is still unavailable, so owner_ready/retired stays closed. */
export async function agentIdentityRetirementReadiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<HistoryReadiness> {
  const receiving = await readAgentIdentitySDKReceivingBinding(tx, artifact, barrier);
  return {
    ready: false,
    gap: receiving.state === 'pending' ? receiving.gap : AGENT_IDENTITY_SDK_RETIREMENT.gap,
  };
}

/** Released SDK receiving observation for inventory presentation. It cannot be used in the
 * source transaction as a certificate. Old executions remain explicitly uncovered. */
export async function readAgentIdentitySDKRetirementGap(
  pool: Pool,
  receipt: IdentitySourceConsumerReference['receipt'],
  context: HistoryReceivingContext,
): Promise<string> {
  historyDeadline(context, 0);
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
