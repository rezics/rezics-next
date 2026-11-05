import { lockRecordHistoryCopy, type RecordHistoryLocalJob } from './record-source-lock.ts';
import type { CommandTransaction } from '../command/command.ts';
import { classifyEvent } from './contracts.ts';
import { decodeLocator } from './locator.ts';
import { agentIdentityCopyRetentionGap } from './agent-identity-source.ts';
import type { HistoryBarrier, HistoryRegistry } from './registry.ts';
import type { HistoryReceivingContext } from './receiving.ts';

/** One envelope slot, never the whole envelope. The owner's proof covers projections and all
 * remaining native consumers; persisted effect dispositions independently cover actual dispatch. */
export async function minimizeHistoryOutbox(
  tx: CommandTransaction,
  job: { partition_no: number; account_route: number; account_id: string } | RecordHistoryLocalJob,
  locator: Buffer,
  registry?: HistoryRegistry,
  barrier?: HistoryBarrier,
  context?: HistoryReceivingContext,
): Promise<string | null> {
  const record = 'authority' in job;
  if (record && !(await lockRecordHistoryCopy(tx, job, 'outbox-event/v1', locator))) return 'record-source-stale';
  const key = decodeLocator('outbox-event/v1', locator);
  if (key.artifactType !== 'outbox-event/v1' || key.partitionNo !== job.partition_no)
    throw new TypeError('Outbox locator home mismatch');
  const identityGap = await agentIdentityCopyRetentionGap(tx, job.partition_no, 'outbox-event/v1', locator);
  if (identityGap) return identityGap;
  const associations = await tx.query(
    `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
     WHERE partition_no=$1 AND artifact_type='outbox-event/v1' AND locator=$2
     ORDER BY account_route,account_id LIMIT 65 FOR UPDATE`,
    [key.partitionNo, locator],
  );
  if (
    associations.rows.length > 64 ||
    associations.rows.some((row) => row.minimizer_version !== 1) ||
    (!record &&
      !associations.rows.some((row) => row.account_route === job.account_route && row.account_id === job.account_id))
  )
    return 'outbox-scope-proof-unavailable';
  const source = await tx.query<{ type: string; payload_state: string }>(
    `SELECT type,payload_state FROM core.outbox
     WHERE partition_no=$1 AND position=$2 AND event_seq=$3 FOR UPDATE`,
    [key.partitionNo, key.position.toString(), key.eventSeq],
  );
  const row = source.rows[0];
  if (!row) return 'outbox-source-missing';
  classifyEvent(row.type);
  if (row.payload_state === 'present') {
    if (record) {
      // This actual closed event has no projection subscriber. Effects still close independently.
      if (row.type !== 'com.rezics.library.entry.purged.v1') return 'outbox-record-consumer-proof-unavailable';
    } else {
      const owner = registry?.owner('outbox-event/v1', row.type);
      if (!owner || !barrier) return 'outbox-owner-consumer-proof-unavailable';
      const readiness = await owner.readiness(
        tx,
        {
          partition: key.partitionNo,
          locator: key,
          accounts: associations.rows.map((ref) => ({
            accountRoute: ref.account_route,
            accountId: ref.account_id,
            roles: ref.roles,
          })),
        },
        barrier,
        context,
      );
      if (!readiness.ready) return readiness.gap;
    }
    const dispatch = await tx.query(
      `SELECT position FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='effects' AND position >= $2`,
      [key.partitionNo, key.position.toString()],
    );
    if (!dispatch.rows.length) return 'outbox-effects-not-dispatched';
    const open = await tx.query(
      `SELECT consumer FROM core.history_event_consumer
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3 AND state='open' ORDER BY consumer LIMIT 1`,
      [key.partitionNo, key.position.toString(), key.eventSeq],
    );
    if (open.rows.length) return 'outbox-effect-consumer-open';
    await tx.query(
      `UPDATE core.outbox SET data='{}'::jsonb,subject=NULL,payload_state='minimized'
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
      [key.partitionNo, key.position.toString(), key.eventSeq],
    );
  } else if (row.payload_state !== 'minimized') throw new TypeError('Unknown outbox payload state');
  if (!record)
    await tx.query(
      `UPDATE core.history_locator SET state='minimized',proof_barrier=$3
     WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 AND artifact_type='outbox-event/v1' AND locator=$4`,
      [job.partition_no, job.account_route, job.account_id, locator],
    );
  return null;
}
