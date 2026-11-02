import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, routeOf } from '../route/route.ts';
import { sealHistoryAccount } from '../history/gates.ts';
import { minimizeHistoryReceipt } from '../history/receipt.ts';
import { minimizeHistoryOutbox } from '../history/outbox.ts';
import { minimizeHistoryWork } from '../history/durable.ts';
import { recordHistoryReceivingProof, type HistoryReceivingContext } from '../history/receiving.ts';
import { decodeLocator } from '../history/locator.ts';
import { historyArtifact, type HistoryArtifactType } from '../history/contracts.ts';
import type { HistoryBarrier, HistoryRegistry } from '../history/registry.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext } from '../work/registry.ts';
import {
  IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE,
  withAgentIdentityHistoryUnit,
  currentAgentIdentityHistoryUnit,
} from '../history/agent-identity-retirement.ts';
import {
  identityHistoryCommand,
  reserveIdentityHistoryWork,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  IdentityHistoryWorkUnavailable,
} from '../history/agent-identity-inventory-work.ts';
import { lockRecordedAgentIdentityHistory } from '../history/agent-identity-sdk-fence.ts';
import { deadlineFor } from '../request/deadline.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { systemClock } from '../clock.ts';
import {
  readAgentIdentityRecoveryArtifactInTransaction,
  type AgentIdentityRecoveryArtifactInspection,
} from '../history/agent-identity-inventory.ts';
import {
  observeAccountErasureSearch,
  type AccountErasureSearchObservation,
} from '../search/account-erasure-source.ts';
import {
  consumeSelectedHistoryOriginal,
  currentIdentityOriginalTransfer,
  identityOriginalRemainder,
  IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING,
  IdentityOriginalUnavailable,
  lockSelectedHistoryOriginalPosition,
  type SelectedHistoryPosition,
  recordSelectedHistoryOriginalProgress,
  withSelectedHistoryOriginalChild,
  guardSelectedHistoryOriginalTransaction,
} from './identity-original-admission.ts';

type Job = {
  job_id: string;
  partition_no: number;
  account_route: number;
  account_id: string;
  barrier_id: string;
  barrier_version: number;
  barrier_at: string;
  scan_partition: number;
  verify_partition: number;
  scan_type: HistoryArtifactType | null;
  scan_locator: Buffer | null;
  phase: 'scan' | 'verify' | 'pending' | 'complete';
  applicable: boolean;
  registry_digest: string;
  registry_generation: string | number;
};
type DeferredRecoveryReceiving = Readonly<{
  receiving: Readonly<{
    job: Job;
    proof: HistoryBarrier;
    type: Extract<HistoryArtifactType, 'command-receipt/v1' | 'outbox-event/v1'>;
    locator: Buffer;
    inspection: AgentIdentityRecoveryArtifactInspection;
    deadline: number;
  }>;
}>;
export type SharedHistoryResult = Readonly<{ state: 'more' | 'pending' | 'complete'; gap: string | null }>;
const result = (state: SharedHistoryResult['state'], gap: string | null = null): SharedHistoryResult => ({
  state,
  gap,
});

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
    [jobId, route >>> 4, route, accountId],
  );
  if (admitted.rows.length !== 1) throw new TypeError('Shared history immutable barrier unavailable');
}

async function barrier(tx: CommandTransaction, job: Job): Promise<HistoryBarrier> {
  const source = await tx.query(
    `SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE`,
    [job.account_route, job.account_id],
  );
  if (
    job.barrier_id !== job.account_id ||
    source.rows[0]?.version !== job.barrier_version ||
    source.rows[0]?.at !== job.barrier_at
  )
    throw new TypeError('Shared history immutable barrier mismatch');
  return {
    accountId: job.account_id,
    accountRoute: job.account_route,
    version: job.barrier_version,
    at: job.barrier_at,
  };
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
  deps: { pool: Pool; client: WorkClient; registry: HistoryRegistry } & Partial<Pick<WorkContext, 'env' | 'clock'>>,
  jobId: string,
): Promise<SharedHistoryResult> {
  const original = currentIdentityOriginalTransfer(deps, jobId);
  if (original) await consumeSelectedHistoryOriginal(deps, original, jobId);
  const originalDeadline = original ? identityOriginalRemainder(deps, original, jobId).deadline : null;
  const deferred = await withConnection(deps.pool, async (connection) => {
    const tx = original ? guardSelectedHistoryOriginalTransaction(deps, original, jobId, connection) : connection;
    if (original) identityOriginalRemainder(deps, original, jobId);
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SET LOCAL lock_timeout='200ms'");
      await tx.query(
        `SET LOCAL statement_timeout='${originalDeadline === null ? 2000 : Math.max(1, Math.min(2000, originalDeadline - Date.now()))}ms'`,
      );
      const job = (
        await tx.query<Job & SelectedHistoryPosition>(
          'SELECT * FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE',
          [jobId],
        )
      ).rows[0];
      if (!job) throw new TypeError('Shared history job unavailable');
      if (original) await lockSelectedHistoryOriginalPosition(deps, original, job, tx);
      const proof = await barrier(tx, job);
      let answer:
        | SharedHistoryResult
        | { work: Buffer; job: Job; proof: HistoryBarrier; identity: boolean }
        | DeferredRecoveryReceiving;
      if (job.phase === 'pending' || job.phase === 'complete') answer = result(job.phase);
      else if (job.phase === 'verify') answer = await verifyHome(tx, job, deps.registry);
      else if (job.scan_partition === PARTITIONS) {
        await tx.query("UPDATE core.preference_history_job SET phase='verify',verify_partition=0 WHERE job_id=$1", [
          jobId,
        ]);
        answer = result('more');
      } else {
        const partition = job.scan_partition;
        const native = (
          await tx.query('SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [partition])
        ).rows[0];
        if (!native || native.write_state !== 'active') {
          await tx.query(
            "UPDATE core.history_progress SET state='pending',proof=NULL WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3",
            [job.account_route, job.account_id, partition],
          );
          // Retrying this native home is necessary; a moved/unavailable home is never skipped.
          answer = result('more', 'partition-unavailable');
          await tx.query("UPDATE core.preference_history_job SET next_run=now()+interval '1 second' WHERE job_id=$1", [
            jobId,
          ]);
        } else {
          await sealHistoryAccount(tx, partition, job.account_route, job.account_id);
          await tx.query(
            `INSERT INTO core.history_progress(account_route,account_id,barrier_id,store_kind,partition_no,partition_epoch)
             VALUES($1,$2,$2,'kernel',$3,$4) ON CONFLICT DO NOTHING`,
            [job.account_route, job.account_id, partition, native.epoch],
          );
          const local = (
            await tx.query(
              `SELECT partition_epoch FROM core.history_progress WHERE account_route=$1 AND account_id=$2
             AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3 FOR UPDATE`,
              [job.account_route, job.account_id, partition],
            )
          ).rows[0];
          if (local.partition_epoch !== native.epoch) {
            await tx.query(
              `UPDATE core.history_progress SET state='pending',proof=NULL,coverage_gap=NULL,partition_epoch=$4
              WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
              [job.account_route, job.account_id, partition, native.epoch],
            );
            await tx.query('UPDATE core.preference_history_job SET scan_type=NULL,scan_locator=NULL WHERE job_id=$1', [
              jobId,
            ]);
            job.scan_type = null;
            job.scan_locator = null;
          }
          if (job.scan_type === null)
            await tx.query(
              `UPDATE core.history_progress SET coverage_gap=NULL
            WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
              [job.account_route, job.account_id, partition],
            );
          const page = await tx.query<{
            artifact_type: HistoryArtifactType;
            locator: Buffer;
            minimizer_version: number;
            state: string;
          }>(
            `SELECT artifact_type,locator,minimizer_version,state FROM core.history_locator
             WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
               AND (artifact_type,locator)>($4::text COLLATE "C",$5::bytea)
             ORDER BY artifact_type,locator LIMIT 8`,
            [partition, job.account_route, job.account_id, job.scan_type ?? '', job.scan_locator ?? Buffer.alloc(0)],
          );
          const first = page.rows[0];
          if (first) {
            historyArtifact(first.artifact_type, first.minimizer_version);
            await tx.query('UPDATE core.preference_history_job SET applicable=true WHERE job_id=$1', [jobId]);
            await tx.query(
              `UPDATE core.history_progress SET applicable=true WHERE account_route=$1 AND account_id=$2
              AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
              [job.account_route, job.account_id, partition],
            );
            const key = { partition_no: partition, account_route: job.account_route, account_id: job.account_id };
            let identity = false;
            if (first.artifact_type === 'durable-work/v1') {
              const selected = decodeLocator('durable-work/v1', first.locator);
              if (selected.artifactType !== 'durable-work/v1') throw new TypeError('Invalid selected durable locator');
              // Classification belongs to the bounded original selection, before the
              // checkout is released. No Source/SDK/receiving observation is made here.
              identity =
                (
                  await tx.query(`SELECT owner FROM core.history_work WHERE partition_no=$1 AND work_id=$2`, [
                    partition,
                    selected.workId,
                  ])
                ).rows[0]?.owner === 'access.agent-identity';
            }
            let recoveryCandidate = false;
            const selectedLocator = decodeLocator(first.artifact_type, first.locator);
            if (selectedLocator.artifactType === 'command-receipt/v1')
              recoveryCandidate =
                commandHistoryKind(selectedLocator.commandKindId) === 'access.agent-identity.recover';
            else if (selectedLocator.artifactType === 'outbox-event/v1') {
              const event = (
                await tx.query<{ type: string }>(
                  'SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3 FOR SHARE',
                  [selectedLocator.partitionNo, selectedLocator.position.toString(), selectedLocator.eventSeq],
                )
              ).rows[0];
              recoveryCandidate = event?.type === 'com.rezics.access.account-updated.v1';
            }
            if (original && !identity)
              answer = result('more', 'identity-history-original-artifact-declaration-unavailable');
            else if (recoveryCandidate) {
              const deadline = originalDeadline ?? deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
              const inspection = await readAgentIdentityRecoveryArtifactInTransaction(
                tx,
                { partition, locator: selectedLocator, accounts: [] },
                deps.pool,
                { deadline },
              );
              answer = {
                receiving: {
                  job,
                  proof,
                  type: selectedLocator.artifactType as Extract<HistoryArtifactType, 'command-receipt/v1' | 'outbox-event/v1'>,
                  locator: first.locator,
                  inspection,
                  deadline,
                },
              };
            }
            else if (first.artifact_type === 'durable-work/v1' && (first.state === 'pending' || identity))
              answer = { work: first.locator, job, proof, identity };
            else {
              let gap =
                first.state === 'minimized'
                  ? null
                  : first.artifact_type === 'command-receipt/v1'
                    ? await minimizeHistoryReceipt(tx, key, first.locator, deps.registry, proof)
                    : await minimizeHistoryOutbox(tx, key, first.locator, deps.registry, proof);
              if (!gap)
                gap = await recordHistoryReceivingProof(
                  tx,
                  proof,
                  partition,
                  decodeLocator(first.artifact_type, first.locator),
                  deps.pool,
                );
              await scannedArtifact(tx, job, first.artifact_type, first.locator, gap);
              answer = result('more');
            }
          } else {
            await tx.query(
              `UPDATE core.history_progress SET state=CASE WHEN coverage_gap IS NULL THEN 'complete' ELSE 'pending' END,
              proof=CASE WHEN coverage_gap IS NOT NULL THEN NULL WHEN applicable THEN 'erased' ELSE 'none' END,
              partition_epoch=$4 WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
              [job.account_route, job.account_id, partition, native.epoch],
            );
            await tx.query(
              `UPDATE core.history_seal SET phase='complete' WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
              AND EXISTS(SELECT 1 FROM core.history_progress h WHERE h.partition_no=$1 AND h.account_route=$2
                AND h.account_id=$3 AND h.barrier_id=$3 AND h.store_kind='kernel' AND h.state='complete')`,
              [partition, job.account_route, job.account_id],
            );
            await tx.query(
              'UPDATE core.preference_history_job SET scan_partition=scan_partition+1,scan_type=NULL,scan_locator=NULL WHERE job_id=$1',
              [jobId],
            );
            answer = result('more');
          }
        }
      }
      if (original) await recordSelectedHistoryOriginalProgress(deps, original, jobId, tx);
      await tx.query('COMMIT');
      return answer;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  if ('receiving' in deferred) return continueRecoveryReceiving(deps, jobId, deferred.receiving);
  if (!('work' in deferred)) return deferred;
  // No source checkout survives SDK calls. Permanent native retirement makes either crash cut replayable.
  const { job, work, proof } = deferred;
  if (deferred.identity) {
    // The selected original enters the sole private transfer. The independent scheduler
    // route remains separate; it cannot replenish an original with missing partitions.
    const parent = original ? identityOriginalRemainder(deps, original, jobId) : null;
    if (original && (!parent || parent.source === null || parent.library === null))
      return result('more', IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING);
    if (!deps.env) return result('more', IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE);
    const clock = deps.clock ?? systemClock;
    try {
      const unitDeps = { pool: deps.pool, client: deps.client, env: deps.env, clock, registry: deps.registry };
      const enter = original
        ? <T>(body: (funded: HistoryReceivingContext) => Promise<T>) =>
            withSelectedHistoryOriginalChild(unitDeps, original, jobId, body)
        : <T>(body: (funded: HistoryReceivingContext) => Promise<T>) =>
            withAgentIdentityHistoryUnit(unitDeps, { deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) }, body);
      return await enter(async (funded) => {
        const gap = await minimizeHistoryWork(
          deps.pool,
          deps.client,
          { partition_no: job.scan_partition, account_route: job.account_route, account_id: job.account_id },
          work,
          deps.registry,
          proof,
          { env: deps.env!, clock },
        );
        if (gap) {
          await identityHistoryCommand(deps.pool, funded, async (tx) => {
            await reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeWrite, funded);
            await tx.query(
              "UPDATE core.preference_history_job SET next_run=now()+interval '10 seconds' WHERE job_id=$1",
              [jobId],
            );
          });
          return result('more', gap);
        }
        const unit = currentAgentIdentityHistoryUnit();
        if (!unit?.stage) return result('more', 'identity-history-current-unit-unavailable');
        return identityHistoryCommand(deps.pool, funded, async (tx) => {
          await reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedJob, funded);
          const current = (
            await tx.query<Job>(`SELECT * FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE`, [jobId])
          ).rows[0];
          if (
            !current ||
            current.phase !== job.phase ||
            current.scan_partition !== job.scan_partition ||
            current.verify_partition !== job.verify_partition ||
            current.registry_digest !== job.registry_digest ||
            String(current.registry_generation) !== String(job.registry_generation) ||
            current.scan_type !== job.scan_type ||
            !sameLocator(current.scan_locator, job.scan_locator) ||
            current.account_id !== job.account_id ||
            current.account_route !== job.account_route ||
            current.barrier_id !== job.barrier_id ||
            current.barrier_version !== job.barrier_version ||
            current.barrier_at !== job.barrier_at
          )
            return result('more', 'identity-history-selected-cursor-changed');
          await reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.selectedBarrier, funded);
          await barrier(tx, current);
          const held = await lockRecordedAgentIdentityHistory(tx, deps.client, unit.stage!, funded);
          if (held.state === 'pending') return result('more', held.gap);
          const receivingGap = await recordHistoryReceivingProof(
            tx,
            proof,
            job.scan_partition,
            decodeLocator('durable-work/v1', work),
            deps.pool,
            funded,
          );
          if (receivingGap) return result('more', receivingGap);
          await reserveIdentityHistoryWork(deps.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeWrite, funded);
          await scannedArtifact(tx, current, 'durable-work/v1', work, null);
          if (original) await recordSelectedHistoryOriginalProgress(deps, original, jobId, tx);
          // The real Source/domain/fence and receiving locks survive this command's COMMIT.
          return result('more');
        });
      });
    } catch (error) {
      if (error instanceof IdentityHistoryWorkUnavailable || error instanceof IdentityOriginalUnavailable)
        return result('more', error.message);
      throw error;
    }
  }
  if (original) return result('more', 'identity-history-original-artifact-declaration-unavailable');
  let gap = await minimizeHistoryWork(
    deps.pool,
    deps.client,
    { partition_no: job.scan_partition, account_route: job.account_route, account_id: job.account_id },
    work,
    deps.registry,
    proof,
    deps.env && deps.clock ? { env: deps.env, clock: deps.clock } : undefined,
  );
  return withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      await tx.query('SELECT job_id FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [jobId]);
      await barrier(tx, job);
      if (gap === IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE || gap === 'identity-source-consumer-custody-pending') {
        // Keep this exact selected cursor for bounded native continuation. The service's
        // ordinary ten-second lease cadence applies; no completed frontier is reset and
        // no new job/account scan or immediate retry is introduced.
        await tx.query("UPDATE core.preference_history_job SET next_run=now()+interval '10 seconds' WHERE job_id=$1", [
          jobId,
        ]);
        await tx.query('COMMIT');
        return result('more', gap);
      }
      if (!gap)
        gap = await recordHistoryReceivingProof(
          tx,
          proof,
          job.scan_partition,
          decodeLocator('durable-work/v1', work),
          deps.pool,
        );
      await scannedArtifact(tx, job, 'durable-work/v1', work, gap);
      await tx.query('COMMIT');
      return result('more');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

async function continueRecoveryReceiving(
  deps: { pool: Pool; client: WorkClient; registry: HistoryRegistry } & Partial<Pick<WorkContext, 'env' | 'clock'>>,
  jobId: string,
  selected: DeferredRecoveryReceiving['receiving'],
): Promise<SharedHistoryResult> {
  let searchObservation: AccountErasureSearchObservation | undefined;
  let recoveryReceivingReserved = false;
  if (selected.inspection.state === 'sealed') {
    const event = selected.inspection.recoveryEvent;
    if (event.locator.artifactType !== 'outbox-event/v1' || event.locator.eventSeq !== 0) {
      searchObservation = { state: 'pending', gap: 'agent-identity-recovery-event-cut-unavailable' };
    } else {
      try {
        await reserveIdentityHistoryWork(
          deps.pool,
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.recoveryReceiving,
          { deadline: selected.deadline },
        );
        recoveryReceivingReserved = true;
        searchObservation = await observeAccountErasureSearch(
          deps.pool,
          {
            accountId: selected.inspection.proof.key.accountId,
            accountPartition: event.partition,
            eventPosition: event.locator.position,
            prefix: deps.env?.KERNEL_SEARCH_PREFIX,
          },
          selected.deadline,
        );
      } catch (error) {
        if (!(error instanceof IdentityHistoryWorkUnavailable)) throw error;
        searchObservation = { state: 'pending', gap: error.message };
      }
    }
  }
  const receivingContext: HistoryReceivingContext = {
    deadline: selected.deadline,
    ...(searchObservation ? { accountErasureSearchObservation: searchObservation } : {}),
    recoveryReceivingReserved,
  };
  return withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SET LOCAL lock_timeout='200ms'");
      await tx.query(
        `SET LOCAL statement_timeout='${Math.max(1, Math.min(2000, selected.deadline - Date.now()))}ms'`,
      );
      const current = (
        await tx.query<Job>('SELECT * FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE', [jobId])
      ).rows[0];
      if (
        !current ||
        current.phase !== selected.job.phase ||
        current.scan_partition !== selected.job.scan_partition ||
        current.verify_partition !== selected.job.verify_partition ||
        current.scan_type !== selected.job.scan_type ||
        !sameLocator(current.scan_locator, selected.job.scan_locator) ||
        current.registry_digest !== selected.job.registry_digest ||
        String(current.registry_generation) !== String(selected.job.registry_generation) ||
        current.account_route !== selected.job.account_route ||
        current.account_id !== selected.job.account_id ||
        current.barrier_id !== selected.job.barrier_id ||
        current.barrier_version !== selected.job.barrier_version ||
        current.barrier_at !== selected.job.barrier_at
      ) {
        await tx.query('COMMIT');
        return result('more', 'identity-history-selected-cursor-changed');
      }
      const proof = await barrier(tx, current);
      const key = {
        partition_no: selected.job.scan_partition,
        account_route: selected.job.account_route,
        account_id: selected.job.account_id,
      };
      let gap =
        selected.type === 'command-receipt/v1'
          ? await minimizeHistoryReceipt(tx, key, selected.locator, deps.registry, proof, receivingContext)
          : await minimizeHistoryOutbox(tx, key, selected.locator, deps.registry, proof, receivingContext);
      if (!gap)
        gap = await recordHistoryReceivingProof(
          tx,
          proof,
          selected.job.scan_partition,
          decodeLocator(selected.type, selected.locator),
          deps.pool,
          receivingContext,
        );
      await scannedArtifact(tx, current, selected.type, selected.locator, gap);
      await tx.query('COMMIT');
      return result('more');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

async function scannedArtifact(
  tx: CommandTransaction,
  job: Job,
  type: HistoryArtifactType,
  locator: Buffer,
  gap: string | null,
) {
  if (gap) {
    if (!/^[a-z0-9_.:/,-]{1,2048}$/.test(gap)) throw new TypeError('Invalid shared history coverage gap');
    await tx.query(
      `UPDATE core.history_progress SET coverage_gap=COALESCE(coverage_gap,$4)
      WHERE account_route=$1 AND account_id=$2 AND barrier_id=$2 AND store_kind='kernel' AND partition_no=$3`,
      [job.account_route, job.account_id, job.scan_partition, gap],
    );
  }
  await tx.query('UPDATE core.preference_history_job SET scan_type=$2,scan_locator=$3 WHERE job_id=$1', [
    job.job_id,
    type,
    locator,
  ]);
}

async function verifyHome(tx: CommandTransaction, job: Job, registry: HistoryRegistry): Promise<SharedHistoryResult> {
  if (job.verify_partition < PARTITIONS) {
    const home = (
      await tx.query(
        `SELECT p.epoch,p.write_state,h.partition_epoch,h.state,h.coverage_gap FROM core.partition p
       LEFT JOIN core.history_progress h ON h.partition_no=p.partition_no AND h.account_route=$2
         AND h.account_id=$3 AND h.barrier_id=$3 AND h.store_kind='kernel'
       WHERE p.partition_no=$1 FOR SHARE OF p`,
        [job.verify_partition, job.account_route, job.account_id],
      )
    ).rows[0];
    if (home?.coverage_gap) return pending(tx, job, home.coverage_gap);
    if (!home || home.write_state !== 'active' || home.state !== 'complete' || home.epoch !== home.partition_epoch) {
      await tx.query(
        "UPDATE core.preference_history_job SET phase='scan',scan_partition=$2,scan_type=NULL,scan_locator=NULL WHERE job_id=$1",
        [job.job_id, job.verify_partition],
      );
    } else
      await tx.query('UPDATE core.preference_history_job SET verify_partition=verify_partition+1 WHERE job_id=$1', [
        job.job_id,
      ]);
    return result('more');
  }
  const gaps = registry.gaps();
  if (gaps.length) return pending(tx, job, gaps.join(','));
  // The operational job may only hold current receiving custody at its own
  // native home. Historical copies-erased rows cannot certify another receiver.
  if (job.partition_no !== Math.floor(job.account_route / 16))
    return pending(tx, job, 'auth-receiving-home-unavailable');
  const auth = await tx.query<{ closure: unknown | null }>(
    'SELECT access.lock_current_auth_receiving_closure($1,$2,$3,$4) AS closure',
    [job.account_route, job.account_id, job.barrier_version, job.barrier_at],
  );
  if (!auth.rows[0]?.closure) return pending(tx, job, 'auth-copies-proof-unavailable');
  // The present router exposes individual home epochs, but no native aggregate invalidation
  // fence. Separate successful reads cannot certify that an earlier home has not moved.
  return pending(tx, job, 'routing-aggregate-proof-unavailable');
}

/** Committed dependency changes, not a timer, reopen a completed scan with a precise missing proof. */
export async function redriveSharedHistory(tx: CommandTransaction, accountId: string): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid shared history account');
  await tx.query('SELECT core.history_wake_account($1,$2)', [route, accountId]);
}

function sameLocator(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
