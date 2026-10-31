import type {
  IdentitySourceConsumerCustody,
  IdentitySourceConsumerReference,
} from '../semantic/identity-source-consumer-custody.ts';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { agentIdentityWorkSourceKey, type AgentIdentityWorkSource } from './agent-identity-source.ts';
import { AGENT_IDENTITY_SDK_FENCE_CONSUMER, readAgentIdentitySDKReceivingBinding } from './agent-identity-sdk-fence.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryReadiness } from './registry.ts';
import sourceSelect from './agent-identity-retirement-source.sql';

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
  const { readIdentitySourceConsumerCustody } = await import('../semantic/identity-source-consumer-custody.ts');
  const consumer = await readIdentitySourceConsumerCustody(pool, fixed, context);
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
