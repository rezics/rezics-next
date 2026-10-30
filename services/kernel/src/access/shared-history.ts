import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, routeOf } from '../route/route.ts';
import { sealHistoryAccount } from '../history/gates.ts';
import { minimizeHistoryReceipt } from '../history/receipt.ts';
import { minimizeHistoryOutbox } from '../history/outbox.ts';
import { minimizeHistoryWork } from '../history/durable.ts';
import { recordHistoryReceivingProof } from '../history/receiving.ts';
import { decodeLocator } from '../history/locator.ts';
import { historyArtifact, type HistoryArtifactType } from '../history/contracts.ts';
import type { HistoryBarrier, HistoryRegistry } from '../history/registry.ts';
import type { WorkClient } from '../work/client.ts';

type Job = {
  job_id: string; account_route: number; account_id: string; barrier_id: string;
  barrier_version: number; barrier_at: string; scan_partition: number; verify_partition: number;
  scan_type: HistoryArtifactType | null; scan_locator: Buffer | null;
  phase: 'scan' | 'verify' | 'pending' | 'complete'; applicable: boolean;
};
export type SharedHistoryResult = Readonly<{ state: 'more' | 'pending' | 'complete'; gap: string | null }>;
const result = (state: SharedHistoryResult['state'], gap: string | null = null): SharedHistoryResult => ({ state, gap });

export async function admitSharedHistory(tx: CommandTransaction, accountId: string, jobId: string): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid shared history account');
  const admitted = await tx.query(
    `INSERT INTO core.preference_history_job(job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at)
     SELECT $1,$2,e.route,e.account_id,e.account_id,e.version,e.at::text FROM access.erasure e
     WHERE e.route=$3 AND e.account_id=$4
     ON CONFLICT(account_route,account_id,barrier_id) DO UPDATE SET barrier_id=EXCLUDED.barrier_id
     WHERE core.preference_history_job.barrier_version=EXCLUDED.barrier_version
       AND core.preference_history_job.barrier_at=EXCLUDED.barrier_at RETURNING job_id`,
    [jobId, route >>> 4, route, accountId]);
  if (admitted.rows.length !== 1) throw new TypeError('Shared history immutable barrier unavailable');
}

async function barrier(tx: CommandTransaction, job: Job): Promise<HistoryBarrier> {
  const source = await tx.query(
    `SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE`,
    [job.account_route, job.account_id]);
  if (job.barrier_id !== job.account_id || source.rows[0]?.version !== job.barrier_version ||
      source.rows[0]?.at !== job.barrier_at) throw new TypeError('Shared history immutable barrier mismatch');
  return { accountId: job.account_id, accountRoute: job.account_route, version: job.barrier_version, at: job.barrier_at };
}

async function pending(tx: CommandTransaction, job: Job, gap: string): Promise<SharedHistoryResult> {
  // Gaps are closed technical codes. No arbitrary exceptions, scopes or payloads enter control state.
  if (!/^[a-z0-9_.:/,-]{1,2048}$/.test(gap)) throw new TypeError('Invalid shared history coverage gap');
  await tx.query("UPDATE core.preference_history_job SET phase='pending',gap=$2 WHERE job_id=$1", [job.job_id, gap]);
  return result('pending', gap);
}

/** One fixed physical home and at most eight keys / one minimizer. Epoch changes invalidate the
 * local certificate. No caller-supplied fixture IDs, account-table scan or other participant ACK. */
export async function advanceSharedHistory(
  deps: { pool: Pool; client: WorkClient; registry: HistoryRegistry }, jobId: string,
): Promise<SharedHistoryResult> {
  const deferred = await withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SET LOCAL lock_timeout='200ms'");
      await tx.query("SET LOCAL statement_timeout='2s'");
      const job = (await tx.query<Job>('SELECT * FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0];
      if (!job) throw new TypeError('Shared history job unavailable');
      const proof = await barrier(tx, job);
      let answer: SharedHistoryResult | { work: Buffer; job: Job; proof: HistoryBarrier };
      if (job.phase === 'pending' || job.phase === 'complete') answer = result(job.phase);
      else if (job.phase === 'verify') answer = await verifyHome(tx, job, deps.registry);
      else if (job.scan_partition === PARTITIONS) {
        await tx.query("UPDATE core.preference_history_job SET phase='verify',verify_partition=0 WHERE job_id=$1", [jobId]);
        answer = result('more');
      } else {
        const partition = job.scan_partition;
        const native = (await tx.query(
          "SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE", [partition])).rows[0];
        if (!native || native.write_state !== 'active') {
          await tx.query("UPDATE core.history_progress SET state='pending',proof=NULL WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3", [job.account_route,job.account_id,partition]);
          // Retrying this native home is necessary; a moved/unavailable home is never skipped.
          answer = result('more', 'partition-unavailable');
          await tx.query("UPDATE core.preference_history_job SET next_run=now()+interval '1 second' WHERE job_id=$1", [jobId]);
        } else {
          await sealHistoryAccount(tx, partition, job.account_route, job.account_id);
          await tx.query(
            `INSERT INTO core.history_progress(account_route,account_id,barrier_id,store_kind,partition_no,partition_epoch)
             VALUES($1,$2,$2,'kernel',$3,$4) ON CONFLICT DO NOTHING`, [job.account_route,job.account_id,partition,native.epoch]);
          const local = (await tx.query(
            `SELECT partition_epoch FROM core.history_progress WHERE account_route=$1 AND account_id=$2
             AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3 FOR UPDATE`, [job.account_route,job.account_id,partition])).rows[0];
          if (local.partition_epoch !== native.epoch) {
            await tx.query(`UPDATE core.history_progress SET state='pending',proof=NULL,coverage_gap=NULL,partition_epoch=$4
              WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`, [job.account_route,job.account_id,partition,native.epoch]);
            await tx.query('UPDATE core.preference_history_job SET scan_type=NULL,scan_locator=NULL WHERE job_id=$1', [jobId]);
            job.scan_type = null; job.scan_locator = null;
          }
          if (job.scan_type === null) await tx.query(`UPDATE core.history_progress SET coverage_gap=NULL
            WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
            [job.account_route,job.account_id,partition]);
          const page = await tx.query<{ artifact_type: HistoryArtifactType; locator: Buffer; minimizer_version: number; state: string }>(
            `SELECT artifact_type,locator,minimizer_version,state FROM core.history_locator
             WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
               AND (artifact_type,locator)>($4::text COLLATE "C",$5::bytea)
             ORDER BY artifact_type,locator LIMIT 8`,
            [partition,job.account_route,job.account_id,job.scan_type ?? '',job.scan_locator ?? Buffer.alloc(0)]);
          const first = page.rows[0];
          if (first) {
            historyArtifact(first.artifact_type, first.minimizer_version);
            await tx.query('UPDATE core.preference_history_job SET applicable=true WHERE job_id=$1', [jobId]);
            await tx.query(`UPDATE core.history_progress SET applicable=true WHERE account_route=$1 AND account_id=$2
              AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`, [job.account_route,job.account_id,partition]);
            const key = { partition_no: partition, account_route: job.account_route, account_id: job.account_id };
            if (first.artifact_type === 'durable-work/v1' && first.state === 'pending') answer = { work: first.locator, job, proof };
            else {
              let gap = first.state === 'minimized' ? null : first.artifact_type === 'command-receipt/v1'
                ? await minimizeHistoryReceipt(tx, key, first.locator, deps.registry, proof)
                : await minimizeHistoryOutbox(tx, key, first.locator, deps.registry, proof);
              if (!gap) gap = await recordHistoryReceivingProof(tx, proof, partition,
                decodeLocator(first.artifact_type, first.locator));
              await scannedArtifact(tx, job, first.artifact_type, first.locator, gap);
              answer = result('more');
            }
          } else {
            await tx.query(`UPDATE core.history_progress SET state=CASE WHEN coverage_gap IS NULL THEN 'complete' ELSE 'pending' END,
              proof=CASE WHEN coverage_gap IS NOT NULL THEN NULL WHEN applicable THEN 'erased' ELSE 'none' END,
              partition_epoch=$4 WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`, [job.account_route,job.account_id,partition,native.epoch]);
            await tx.query(`UPDATE core.history_seal SET phase='complete' WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
              AND EXISTS(SELECT 1 FROM core.history_progress h WHERE h.partition_no=$1 AND h.account_route=$2
                AND h.account_id=$3 AND h.barrier_id=$3 AND h.store_kind='kernel' AND h.state='complete')`, [partition,job.account_route,job.account_id]);
            await tx.query('UPDATE core.preference_history_job SET scan_partition=scan_partition+1,scan_type=NULL,scan_locator=NULL WHERE job_id=$1', [jobId]);
            answer = result('more');
          }
        }
      }
      await tx.query('COMMIT');
      return answer;
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
  });
  if (!('work' in deferred)) return deferred;
  // No source checkout survives SDK calls. Permanent native retirement makes either crash cut replayable.
  const { job, work, proof } = deferred;
  let gap = await minimizeHistoryWork(deps.pool,deps.client,
    { partition_no: job.scan_partition, account_route: job.account_route, account_id: job.account_id },work,deps.registry,proof);
  return withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      await tx.query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [jobId]);
      await barrier(tx,job);
      if (!gap) gap = await recordHistoryReceivingProof(tx,proof,job.scan_partition,decodeLocator('durable-work/v1',work));
      await scannedArtifact(tx,job,'durable-work/v1',work,gap);
      await tx.query('COMMIT'); return result('more');
    }
    catch(error){await tx.query('ROLLBACK');throw error;}
  });
}

async function scannedArtifact(tx: CommandTransaction, job: Job, type: HistoryArtifactType, locator: Buffer, gap: string | null) {
  if (gap) {
    if (!/^[a-z0-9_.:/,-]{1,2048}$/.test(gap)) throw new TypeError('Invalid shared history coverage gap');
    await tx.query(`UPDATE core.history_progress SET coverage_gap=COALESCE(coverage_gap,$4)
      WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
      [job.account_route,job.account_id,job.scan_partition,gap]);
  }
  await tx.query('UPDATE core.preference_history_job SET scan_type=$2,scan_locator=$3 WHERE job_id=$1', [job.job_id,type,locator]);
}

async function verifyHome(tx: CommandTransaction, job: Job, registry: HistoryRegistry): Promise<SharedHistoryResult> {
  if (job.verify_partition < PARTITIONS) {
    const home = (await tx.query(
      `SELECT p.epoch,p.write_state,h.partition_epoch,h.state,h.coverage_gap FROM core.partition p
       LEFT JOIN core.history_progress h ON h.partition_no=p.partition_no AND h.account_route=$2
         AND h.account_id=$3 AND h.barrier_id=$3 AND h.store_kind='kernel'
       WHERE p.partition_no=$1 FOR SHARE OF p`, [job.verify_partition,job.account_route,job.account_id])).rows[0];
    if (home?.coverage_gap) return pending(tx,job,home.coverage_gap);
    if (!home || home.write_state !== 'active' || home.state !== 'complete' || home.epoch !== home.partition_epoch) {
      await tx.query("UPDATE core.preference_history_job SET phase='scan',scan_partition=$2,scan_type=NULL,scan_locator=NULL WHERE job_id=$1", [job.job_id,job.verify_partition]);
    } else await tx.query('UPDATE core.preference_history_job SET verify_partition=verify_partition+1 WHERE job_id=$1', [job.job_id]);
    return result('more');
  }
  const gaps = registry.gaps();
  if (gaps.length) return pending(tx,job,gaps.join(','));
  const auth = await tx.query(`SELECT version,at::text FROM access.auth_history_proof
    WHERE route=$1 AND account_id=$2 AND phase='copies-erased'`, [job.account_route,job.account_id]);
  if (auth.rows[0]?.version !== job.barrier_version || auth.rows[0]?.at !== job.barrier_at)
    return pending(tx,job,'auth-copies-proof-unavailable');
  // The present router exposes individual home epochs, but no native aggregate invalidation
  // fence. Separate successful reads cannot certify that an earlier home has not moved.
  return pending(tx,job,'routing-aggregate-proof-unavailable');
}

/** Committed dependency changes, not a timer, reopen a completed scan with a precise missing proof. */
export async function redriveSharedHistory(tx: CommandTransaction, accountId: string): Promise<void> {
  const route=routeOf(accountId);
  if(route===null) throw new TypeError('Invalid shared history account');
  await tx.query('SELECT core.history_wake_account($1,$2)',[route,accountId]);
}
