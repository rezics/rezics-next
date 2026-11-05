import { withConnection } from '../database/pool.ts';
import { consumerReady, readConsumerLag } from '../events/consumer-lag.ts';
import type { AccessClient } from '../request/access.ts';
import type { Pool } from 'pg';
import { countTransaction, type CountRuntime } from './follow-count-source.ts';
import { FollowCountUnavailableError } from './follow-count-target.ts';

const MAX_AGE_MS = 300_000;
const SOURCE_TRANSACTION_MS = 5_000;

export type FollowCountHealthObservation = Readonly<{
  sampledAt: string;
  oldestPendingAt: string | null;
  consumerObservedAt: string;
  consumerOldestPendingAt: string | null;
}>;

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

/** Constant root metadata in the caller's native snapshot. No partition/follower scan. */
export async function readFollowCountHealthObservation(tx: AccessClient): Promise<FollowCountHealthObservation> {
  const row = (
    await tx.query<{
      ready: boolean;
      members: number;
      now: string;
      sampled_at: string | null;
      oldest_pending_at: string | null;
    }>(
      `SELECT ready,members,clock_timestamp()::text AS now,sampled_at::text,oldest_pending_at::text
       FROM library.follow_count_health WHERE node=0`,
    )
  ).rows[0];
  if (!row || !row.ready || !row.members || !row.sampled_at) throw new FollowCountUnavailableError();
  const now = new Date(row.now);
  const sampleAge = now.getTime() - new Date(row.sampled_at).getTime();
  const pendingAge = row.oldest_pending_at === null ? 0 : now.getTime() - new Date(row.oldest_pending_at).getTime();
  const lag = await readConsumerLag(tx, 'effects');
  // All times come from the same native database clock. The extra five seconds
  // conservatively cover a source command still uncommitted at sample time.
  if (
    !Number.isFinite(sampleAge) ||
    !Number.isFinite(pendingAge) ||
    sampleAge < 0 ||
    pendingAge < 0 ||
    Math.max(sampleAge, pendingAge) + SOURCE_TRANSACTION_MS > MAX_AGE_MS ||
    !consumerReady(lag, { now, maxLagMs: MAX_AGE_MS })
  )
    throw new FollowCountUnavailableError();
  return {
    sampledAt: row.sampled_at,
    oldestPendingAt: row.oldest_pending_at,
    consumerObservedAt: lag!.observedAt.toISOString(),
    consumerOldestPendingAt: lag!.oldestPendingAt?.toISOString() ?? null,
  };
}

/** Constant root metadata at each end of a private read. No partition/follower scan. */
export async function requireFollowCountHealth(pool: Pool): Promise<FollowCountHealthObservation> {
  return withConnection(pool, readFollowCountHealthObservation);
}
