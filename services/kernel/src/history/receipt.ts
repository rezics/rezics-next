import { lockRecordHistoryCopy, type RecordHistoryLocalJob } from './record-source-lock.ts';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { CommandTransaction } from '../command/command.ts';
import { decodeLocator } from './locator.ts';
import { sealHistoryAccount } from './gates.ts';
import minimize from './receipt.sql';
import { commandHistoryKind } from './record.ts';
import { agentIdentityCopyRetentionGap } from './agent-identity-source.ts';
import type { HistoryBarrier, HistoryRegistry } from './registry.ts';
import type { HistoryReceivingContext } from './receiving.ts';

/** Actual owner disposition: this response has no downstream workflow consumers. No other
 * receipt kind acquires readiness from age, DBOS state or this registration. */
export const RECEIPT_OWNER_DISPOSITIONS = Object.freeze({
  'access.account.preferences': Object.freeze({ commandKindId: 1, minimizerVersion: 1, barrierCompletesResult: true }),
  'library.entry.retention.purge': Object.freeze({
    commandKindId: 2,
    minimizerVersion: 1,
    barrierCompletesResult: true,
  }),
  // Recovery receipts have no response workflow. Their independent two-slot native cut
  // and current account-updated receiver remain required before physical minimization.
  'access.agent-identity.recover': Object.freeze({
    commandKindId: 7,
    minimizerVersion: 1,
    barrierCompletesResult: true,
  }),
});
export type PreferenceHistoryCode = 'more' | 'covered-pending';
type Job = {
  partition_no: number;
  account_route: number;
  account_id: string;
  barrier_id: string;
  state: PreferenceHistoryCode | 'pending';
  cursor: Buffer | null;
};

export async function minimizeHistoryReceipt(
  tx: CommandTransaction,
  job: Pick<Job, 'partition_no' | 'account_route' | 'account_id'> | RecordHistoryLocalJob,
  locator: Buffer,
  registry?: HistoryRegistry,
  barrier?: HistoryBarrier,
  context?: HistoryReceivingContext,
): Promise<string | null> {
  const record = 'authority' in job;
  if (record && !(await lockRecordHistoryCopy(tx, job, 'command-receipt/v1', locator))) return 'record-source-stale';
  const key = decodeLocator('command-receipt/v1', locator);
  if (key.artifactType !== 'command-receipt/v1' || key.partitionNo !== job.partition_no)
    throw new TypeError('Receipt owner disposition unavailable');
  const kind = commandHistoryKind(key.commandKindId);
  if (!kind) return 'receipt-owner-unregistered';
  const identityGap = await agentIdentityCopyRetentionGap(tx, job.partition_no, 'command-receipt/v1', locator);
  if (identityGap) return identityGap;
  const storageKey = `rk1.${key.keyVersion}.${Buffer.from(key.keyToken, 'hex').toString('base64url')}`;
  // Artifact-leading inverse bounds every association without enumerating account prefixes.
  const associations = await tx.query(
    `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
    WHERE partition_no=$1 AND artifact_type='command-receipt/v1' AND locator=$2
    ORDER BY account_route,account_id LIMIT 65 FOR UPDATE`,
    [job.partition_no, locator],
  );
  if (
    associations.rows.length > 64 ||
    associations.rows.some((row) => row.minimizer_version !== 1) ||
    (!record &&
      !associations.rows.some((row) => row.account_route === job.account_route && row.account_id === job.account_id))
  )
    throw new TypeError('Receipt source scope proof unavailable');
  if (record) {
    // These native dispositions explicitly have no response consumers, including living work.
    // An account-erasure readiness callback is never reused as ordinary-record permission.
    if (!Object.hasOwn(RECEIPT_OWNER_DISPOSITIONS, kind)) return 'receipt-record-consumer-proof-unavailable';
  } else if (registry) {
    const owner = registry.owner('command-receipt/v1', kind);
    if (!owner || !barrier) return 'receipt-consumer-proof-unavailable';
    const readiness = await owner.readiness(
      tx,
      {
        partition: job.partition_no,
        locator: key,
        accounts: associations.rows.map((row) => ({
          accountRoute: row.account_route,
          accountId: row.account_id,
          roles: row.roles,
        })),
      },
      barrier,
      context,
    );
    if (!readiness.ready) return readiness.gap;
  } else if (kind !== 'access.account.preferences') return 'receipt-consumer-proof-unavailable';
  const params = [key.partitionNo, key.principalKind, key.principalId, storageKey, kind];
  const source = await tx.query(
    `SELECT payload_state FROM core.receipt
    WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3
      AND command_kind=$5 AND idempotency_key=$4 FOR UPDATE`,
    params,
  );
  if (source.rows.length !== 1) throw new TypeError('Receipt source proof unavailable');
  if (source.rows[0].payload_state === 'present') {
    const changed = await minimize.run(tx, {
      partition_no: key.partitionNo,
      principal_kind: key.principalKind,
      principal_id: key.principalId,
      storage_key: storageKey,
      command_kind: kind,
    });
    if (!changed) throw new TypeError('Receipt minimization lost its source');
  } else if (source.rows[0].payload_state !== 'minimized') throw new TypeError('Unknown receipt payload state');
  // A live account's association remains pending until its own committed barrier exists. This
  // account's proof and the physical response mutation always commit or roll back together.
  if (!record)
    await tx.query(
      `UPDATE core.history_locator SET state='minimized',proof_barrier=$3
    WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
      AND artifact_type='command-receipt/v1' AND locator=$4`,
      [job.partition_no, job.account_route, job.account_id, locator],
    );
  return null;
}

/** One exact receipt per partition transaction. Partial coverage never emits a participant ACK,
 * a global none proof, or history_progress.complete, including when the prefix is empty. */
export async function advancePreferenceHistory(pool: Pool, jobId: string): Promise<PreferenceHistoryCode> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query("SET LOCAL lock_timeout='200ms'");
      await client.query("SET LOCAL statement_timeout='2s'");
      const result = await client.query<Job>('SELECT * FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [
        jobId,
      ]);
      const job = result.rows[0];
      if (!job) throw new TypeError('Preference erasure job unavailable');
      if (job.state === 'covered-pending') {
        await client.query('COMMIT');
        return 'covered-pending';
      }
      await sealHistoryAccount(client, job.partition_no, job.account_route, job.account_id);
      const partition = await client.query(
        `SELECT epoch FROM core.partition
        WHERE partition_no=$1 AND write_state='active' FOR SHARE`,
        [job.partition_no],
      );
      if (partition.rows.length !== 1) throw new Error('Preference erasure partition unavailable');
      await client.query(
        `INSERT INTO core.history_progress
        (account_route,account_id,barrier_id,store_kind,partition_no,partition_epoch)
        VALUES($1,$2,$2,'kernel',$3,$4) ON CONFLICT DO NOTHING`,
        [job.account_route, job.account_id, job.partition_no, partition.rows[0].epoch],
      );
      const page = await client.query<{ locator: Buffer }>(
        `SELECT locator FROM core.history_locator
        WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
          AND artifact_type='command-receipt/v1' AND state='pending' AND locator>$4
        ORDER BY locator LIMIT 8`,
        [job.partition_no, job.account_route, job.account_id, job.cursor ?? Buffer.alloc(0)],
      );
      const first = page.rows[0];
      if (first) {
        const gap = await minimizeHistoryReceipt(client, job, first.locator);
        if (gap) throw new TypeError(gap);
        await client.query('UPDATE core.preference_history_job SET cursor=$2 WHERE job_id=$1', [jobId, first.locator]);
        await client.query(
          `UPDATE core.history_progress SET partition_epoch=$4,artifact_type='command-receipt/v1',locator=$5
          WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
          [job.account_route, job.account_id, job.partition_no, partition.rows[0].epoch, first.locator],
        );
      } else {
        await client.query("UPDATE core.preference_history_job SET state='covered-pending' WHERE job_id=$1", [jobId]);
      }
      await client.query('COMMIT');
      return first ? 'more' : 'covered-pending';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
