import type { Pool } from 'pg';
import { currentCommandResources, hasLiveCommandTransaction, type CommandTransaction } from '../command/command.ts';
import {
  IdentityHistoryWorkUnavailable,
  reserveIdentityHistoryWork,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
} from './agent-identity-inventory-work.ts';
import { readAgentIdentityRecoveryArtifactInTransaction } from './agent-identity-inventory.ts';
import {
  verifyAccountErasureSearchObservation,
  type AccountErasureSearchObservation,
} from '../search/account-erasure-source.ts';
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
  source?: Readonly<{
    deadline?: number;
    searchObservation?: AccountErasureSearchObservation;
    recoveryReceivingReserved?: boolean;
  }>,
): Promise<AgentIdentityRecoveryArtifactReadiness> {
  // The background History worker supplies a bounded Pool/deadline after releasing its first
  // transaction. Callers without that context stay pending; it grants no Search or completion truth.
  const commandResources = hasLiveCommandTransaction(tx) ? currentCommandResources(tx) : undefined;
  const resources =
    commandResources ??
    (pool && source?.deadline && Number.isFinite(source.deadline) && source.deadline > Date.now()
      ? { pool, deadline: source.deadline }
      : undefined);
  if (!resources) return { state: 'pending', gap: 'agent-identity-recovery-command-resources-unavailable' };
  if (pool && pool !== resources.pool) throw new TypeError('Recovery receiving pool differs from its command');
  const cut = await readAgentIdentityRecoveryArtifactInTransaction(tx, artifact, resources.pool, {
    deadline: resources.deadline,
  });
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

  if (!source?.recoveryReceivingReserved) {
    try {
      await reserveIdentityHistoryWork(
        resources.pool,
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.recoveryReceiving,
        { deadline: resources.deadline },
      );
    } catch (error) {
      if (error instanceof IdentityHistoryWorkUnavailable) return { state: 'pending', gap: error.message };
      throw error;
    }
  }
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
  if (!eventRow || eventRow.epoch !== cut.proof.epoch || eventRow.event_count !== 1 || (!present && !minimized))
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

  const searchInput = {
    accountId: cut.proof.key.accountId,
    accountPartition: event.partition,
    eventPosition: event.locator.position,
  };
  if (!source?.searchObservation)
    return { state: 'pending', gap: 'agent-identity-recovery-search-observation-unavailable' };
  return verifyAccountErasureSearchObservation(tx, searchInput, source.searchObservation);
}
