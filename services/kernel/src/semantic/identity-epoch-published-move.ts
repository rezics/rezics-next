import type { CommandTransaction } from '../command/command.ts';
import { IdentityEpochStoreError } from './contract/identity-errors.ts';
import { identityJobPartition } from './identity-adapters/identity-epoch-contract.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';

/** Retain only the exact prior terminals. Even offers that keep their terminal
 * need the new mapping epoch, so the consumer pages each of its own directories.
 */
export async function readPublishedIdentityMoveScopes(tx: CommandTransaction, job: IdentityJobRef): Promise<string[]> {
  const result = await tx.query<{ terminal: string; current: boolean }>(
    `SELECT i.terminal::text,(p.partition_no IS NOT NULL) AS current
    FROM semantic.identity_epoch_job j
    JOIN semantic.identity_epoch_input i USING(partition_no,job_id)
    JOIN semantic.identity_epoch_native_commit a
      ON (a.partition_no,a.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND a.purpose='admission'
    JOIN core.partition owner ON owner.partition_no=j.partition_no AND owner.epoch=a.epoch
      AND owner.position>=a.position AND owner.write_state='active' AND owner.moved_to IS NULL
    LEFT JOIN core.partition p ON p.partition_no=i.control_partition AND p.epoch=i.owner_epoch
      AND p.write_state='active' AND p.moved_to IS NULL
    WHERE (j.partition_no,j.job_id,j.epoch)=($1,$2,$3) AND j.state='published'
    ORDER BY i.terminal LIMIT 3`,
    [identityJobPartition(job), job.jobId, job.epoch.toString()],
  );
  if (result.rows.length < 1 || result.rows.length > 2 || result.rows.some((row) => !row.current))
    throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Published identity move source is unavailable');
  return result.rows.map((row) => row.terminal);
}
