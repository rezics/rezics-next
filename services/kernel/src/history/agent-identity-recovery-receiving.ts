import type { Pool } from 'pg';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { reserveIdentityHistoryWork, nativeWork } from './agent-identity-inventory-work.ts';
import { readAgentIdentityRecoveryArtifactInTransaction } from './agent-identity-inventory.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';

export type AgentIdentityRecoveryArtifactReadiness =
  | Readonly<{ state: 'not-recovery' }>
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'ready' }>;

/** The recovery receipt and wakeup have no original verification/reversal SDK handoff.
 * Their receiving closure is the exact account-discovery effect plus every active Search generation. */
export async function verifyAgentIdentityRecoveryArtifactReadiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier?: HistoryBarrier,
  pool?: Pool,
): Promise<AgentIdentityRecoveryArtifactReadiness> {
  const resources = currentCommandResources(tx);
  if (pool && pool !== resources.pool) throw new TypeError('Recovery receiving pool differs from its command');
  const cut = await readAgentIdentityRecoveryArtifactInTransaction(tx, artifact, resources.pool);
  if (cut.state === 'absent') return { state: 'not-recovery' };
  if (cut.state === 'pending') return { state: 'pending', gap: cut.gap };
  if (
    artifact.accounts.length > 0 &&
    JSON.stringify(
      [...artifact.accounts]
        .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId))
        .map(({ accountRoute, accountId, roles }) => [accountRoute, accountId, roles]),
    ) !==
      JSON.stringify(
        [...cut.artifact.accounts]
          .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId))
          .map(({ accountRoute, accountId, roles }) => [accountRoute, accountId, roles]),
      )
  )
    return { state: 'pending', gap: 'agent-identity-recovery-artifact-scope-changed' };
  if (
    barrier &&
    !cut.artifact.accounts.some(
      (account) => account.accountRoute === barrier.accountRoute && account.accountId === barrier.accountId,
    )
  )
    return { state: 'pending', gap: 'agent-identity-recovery-barrier-role-unavailable' };

  await reserveIdentityHistoryWork(resources.pool, nativeWork(100, 100, 36, 24576), {
    deadline: resources.deadline,
  });
  const event = cut.recoveryEvent;
  if (event.locator.artifactType !== 'outbox-event/v1' || event.locator.eventSeq !== 0)
    return { state: 'pending', gap: 'agent-identity-recovery-event-cut-unavailable' };
  const eventRow = (
    await tx.query<{
      epoch: number;
      event_count: number;
      payload_state: string;
      subject: string | null;
      data: unknown;
    }>(
      `SELECT epoch,event_count,payload_state,subject,data FROM core.outbox
       WHERE partition_no=$1 AND position=$2 AND event_seq=0
         AND type='com.rezics.access.account-updated.v1' FOR SHARE`,
      [event.partition, event.locator.position.toString()],
    )
  ).rows[0];
  const present =
    eventRow?.payload_state === 'present' &&
    eventRow.subject === cut.proof.key.accountId &&
    JSON.stringify(eventRow.data) === JSON.stringify({ accountId: cut.proof.key.accountId });
  const minimized =
    eventRow?.payload_state === 'minimized' &&
    eventRow.subject === null &&
    JSON.stringify(eventRow.data) === JSON.stringify({});
  if (
    !eventRow ||
    eventRow.epoch !== cut.proof.epoch ||
    eventRow.event_count !== 1 ||
    (!present && !minimized)
  )
    return { state: 'pending', gap: 'agent-identity-recovery-event-unavailable' };
  const effects = (
    await tx.query(
      `SELECT position FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='effects' AND position >= $2 FOR SHARE`,
      [event.partition, event.locator.position.toString()],
    )
  ).rows[0];
  if (!effects) return { state: 'pending', gap: 'agent-identity-recovery-effects-pending' };
  const consumers = (
    await tx.query<{ consumer: string; workflow_id: string; state: string }>(
      `SELECT consumer,workflow_id,state FROM core.history_event_consumer
       WHERE partition_no=$1 AND position=$2 AND event_seq=0
       ORDER BY consumer LIMIT 33 FOR SHARE`,
      [event.partition, event.locator.position.toString()],
    )
  ).rows;
  const expectedWorkflow = `fx:${eventRow.epoch}:${event.partition}:${event.locator.position}:0:account_discovery_redrive`;
  if (
    consumers.length !== 1 ||
    consumers[0]?.consumer !== 'account_discovery_redrive' ||
    consumers[0]?.workflow_id !== expectedWorkflow ||
    consumers[0]?.state !== 'completed'
  )
    return { state: 'pending', gap: 'agent-identity-recovery-effect-consumer-unavailable' };

  // The installed History/Work composition has no Search owner callback that can provide
  // a released current-enrollment observation and its owner-verified same-home result.
  // A partition-zero generation list or relay checkpoint is not receiving authority.
  return { state: 'pending', gap: 'agent-identity-recovery-discovery-owner-unavailable' };
}
