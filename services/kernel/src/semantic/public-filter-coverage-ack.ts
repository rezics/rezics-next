import type { Pool } from 'pg';
import { withConnection, discardConnection } from '../database/pool.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';

/** Internal native receipt, resolved from the original independently verified
 * home/window chain. Never accepted by a public callable or a caller ACK setter.
 */
export type PublicFilterRepairBaseline = Readonly<{
  bootstrap: string; registration: string; registrationPartition: number; home: number;
  epoch: number; receipt: string; sourcePosition: string; enqueue: string;
  revision: string | null; claimRevision: string | null;
  observation: string; execution: string; settlement: string;
}>;

/** ACK only this original baseline's complete prefix. Subsequent Source positions
 * and native enqueue revisions remain obligations even if delivered meanwhile.
 * Apply and ACK serialize on the SAME registration and coverage-summary locks.
 */
export async function acknowledgePublicFilterRepairBaseline(
  pool: Pool, baseline: PublicFilterRepairBaseline, deadline: number,
): Promise<boolean> {
  requireAccessDeadline(deadline);
  return withConnection(pool,async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1,Math.floor(deadline-Date.now()))}ms'`);
      const owner = (await client.query<{ write_state: string }>(
        'SELECT write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
        [baseline.registrationPartition],
      )).rows[0];
      const registration = (await client.query<{ state: string }>(
        `SELECT state FROM search.public_filter_registration
         WHERE (partition_no,id)=($1,$2) FOR UPDATE`,
        [baseline.registrationPartition,baseline.registration],
      )).rows[0];
      if (!owner || owner.write_state !== 'active' || registration?.state !== 'active')
        throw new CommandUnavailableError('fenced',baseline.registrationPartition);
      const summary = (await client.query<{
        source_epoch: number; baseline_bootstrap: string; acknowledged_position: string;
        acknowledged_native_enqueue: string;
      }>(
        `SELECT source_epoch,baseline_bootstrap::text,acknowledged_position::text,
           acknowledged_native_enqueue::text
         FROM search.public_filter_coverage_home
         WHERE (partition_no,registration,source_home)=($1,$2,$3) FOR UPDATE`,
        [baseline.registrationPartition,baseline.registration,baseline.home],
      )).rows[0];
      const original = (await client.query<{ receipt: string; source_epoch: number;
        source_position: string; native_enqueue_revision: string;
        native_revision: string | null; native_claim_revision: string | null }>(
        `SELECT receipt,source_epoch,source_position::text,native_enqueue_revision::text,
           native_revision::text,native_claim_revision::text
         FROM search.public_filter_coverage_baseline
         WHERE (partition_no,registration,bootstrap,source_home)=($1,$2,$3,$4)`,
        [baseline.registrationPartition,baseline.registration,baseline.bootstrap,baseline.home],
      )).rows[0];
      if (!summary || !original || summary.source_epoch !== baseline.epoch ||
        summary.baseline_bootstrap !== baseline.bootstrap || original.receipt !== baseline.receipt ||
        original.source_epoch !== baseline.epoch || original.source_position !== baseline.sourcePosition ||
        original.native_enqueue_revision !== baseline.enqueue || original.native_revision !== baseline.revision ||
        original.native_claim_revision !== baseline.claimRevision ||
        BigInt(summary.acknowledged_position)>BigInt(baseline.sourcePosition) ||
        BigInt(summary.acknowledged_native_enqueue)>BigInt(baseline.enqueue))
        throw new CommandUnavailableError('contention',baseline.registrationPartition);
      // The verified full native baseline plus its original creation/change
      // successors covers every obligation through these exact positions. This
      // is not max(delivered), a counter tick, or an event-delivery receipt.
      await client.query(
        `UPDATE search.public_filter_coverage_home SET
           acknowledged_position=$4::bigint,acknowledged_native_enqueue=$5::bigint,
           acknowledged_native_revision=$6::bigint,acknowledged_native_claim_revision=$7::bigint,
           acknowledged_baseline=$8::uuid,
           acknowledged_observation=$9,acknowledged_execution=$10,acknowledged_settlement=$11,
           behind=(relevant_position>$4::bigint OR native_enqueue_revision>$5::bigint
             OR native_revision IS DISTINCT FROM $6::bigint
             OR native_claim_revision IS DISTINCT FROM $7::bigint)
         WHERE (partition_no,registration,source_home)=($1,$2,$3)`,
        [baseline.registrationPartition,baseline.registration,baseline.home,baseline.sourcePosition,
          baseline.enqueue,baseline.revision,baseline.claimRevision,baseline.bootstrap,
          baseline.observation,baseline.execution,baseline.settlement],
      );
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { discardConnection(client,rollbackError as Error); }
      throw error;
    }
  });
}
