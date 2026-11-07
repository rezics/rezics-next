import { countTransaction, type CountRuntime } from './follow-count-runtime.ts';
import { FollowCountUnavailableError } from '../contract/index.ts';
export {
  requireFollowCountHealth,
  readFollowCountHealthObservation,
  type FollowCountHealthObservation,
} from './follow-count-observation.ts';

/** One native partition sample, three bounded 16-child reductions. Stale children
 * retain their timestamp; a parent cannot refresh it by running again. */
export async function sampleFollowCountHealth(deps: CountRuntime, partition: number) {
  await countTransaction(deps, partition * 16, 'library.follow-count.sample', async (tx) => {
    const result = await tx.query<{
      ready: boolean;
      opened: boolean;
      sampled_at: string;
      oldest_pending_at: string | null;
    }>(
      `SELECT p.source_complete AND p.target_kind=3
         AND NOT EXISTS(SELECT 1 FROM library.follow_count_owner WHERE partition_no=$1 AND NOT bootstrap_complete ORDER BY route,account_id LIMIT 1)
         AND c.write_state='active' AS ready, p.opened,  clock_timestamp()::text AS sampled_at,
         LEAST((SELECT pending_since FROM library.follow_count_source WHERE partition_no=$1 AND pending_since IS NOT NULL
           ORDER BY pending_since,route,account_id,target_type,target_id LIMIT 1),
         (SELECT oldest_pending_at FROM library.follow_count_account_work WHERE (route >> 4)=$1
           ORDER BY oldest_pending_at,route,account_id LIMIT 1),
         (SELECT oldest_pending_at FROM library.follow_count_terminal_source WHERE partition_no=$1 AND NOT local_complete
           ORDER BY oldest_pending_at,account_id LIMIT 1))::text AS oldest_pending_at
       FROM library.follow_count_partition p JOIN core.partition c USING(partition_no) WHERE p.partition_no=$1`,
      [partition],
    );
    const sample = result.rows[0];
    if (!sample) throw new FollowCountUnavailableError('Missing source partition topology');
    const ready = sample.ready && (sample.opened || sample.oldest_pending_at === null);
    if (ready && !sample.opened)
      await tx.query('UPDATE library.follow_count_partition SET opened=true WHERE partition_no=$1', [partition]);
    await tx.query(`UPDATE library.follow_count_health SET sampled_at=$2,oldest_pending_at=$3,ready=$4 WHERE node=$1`, [
      273 + partition,
      sample.sampled_at,
      sample.oldest_pending_at,
      ready,
    ]);
    let node = 273 + partition;
    while (node > 0) {
      node = Math.floor((node - 1) / 16);
      await tx.query('SELECT node FROM library.follow_count_health WHERE node=$1 FOR UPDATE', [node]);
      await tx.query(
        `UPDATE library.follow_count_health SET
        sampled_at=child.sampled_at,oldest_pending_at=child.oldest_pending_at,ready=child.ready
        FROM (SELECT min(sampled_at) AS sampled_at,min(oldest_pending_at) AS oldest_pending_at,
          bool_and(ready AND sampled_at IS NOT NULL) AS ready
          FROM library.follow_count_health WHERE node BETWEEN $2 AND $3 AND members>0) child
        WHERE node=$1`,
        [node, node * 16 + 1, node * 16 + 16],
      );
    }
  });
}
