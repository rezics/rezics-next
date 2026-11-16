import type { PoolClient } from 'pg';
import { withBoundedCommandConnection } from '../../database/pool.ts';
import { coverInitializedFollowCountHomes } from './follow-count-bootstrap.ts';
import { countTransaction, workStepDeadline, type CountRuntime } from './follow-count-runtime.ts';
import { FollowCountUnavailableError } from '../contract/index.ts';
export {
  requireFollowCountHealth,
  readFollowCountHealthObservation,
  type FollowCountHealthObservation,
} from './follow-count-observation.ts';

type Connection = Pick<PoolClient, 'query'>;
const FIRST_LEAF = 273;
const FANOUT = 16;

/** A scheduled page shares a checkout and reduces each affected ancestor once.
 * Each home still has its own native fence, coverage, and indexed pending probes. */
export async function sampleFollowCountHealthPage(deps: CountRuntime, partitions: number[]) {
  return withBoundedCommandConnection(deps.pool, workStepDeadline(), async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const { rows } = await tx.query<{ partition_no: number }>(
        `SELECT p.partition_no FROM library.follow_count_partition p
         JOIN core.partition c USING(partition_no)
         WHERE p.partition_no=ANY($1::integer[]) AND c.write_state='active'
         ORDER BY p.partition_no FOR SHARE OF c FOR NO KEY UPDATE OF p`,
        [partitions],
      );
      const active = rows.map(({ partition_no }) => partition_no);
      await coverInitializedFollowCountHomes(tx, active);
      const pending = await sampleAndReduce(tx, active);
      await tx.query('COMMIT');
      return [...pending, ...partitions.filter((partition) => !active.includes(partition))];
    } catch (cause) {
      await tx.query('ROLLBACK').catch(() => {});
      throw cause;
    }
  });
}

export async function sampleFollowCountHealth(deps: CountRuntime, partition: number) {
  await countTransaction(deps, partition * 16, 'library.follow-count.sample', async (tx) => {
    const row = await tx.query(
      'SELECT partition_no FROM library.follow_count_partition WHERE partition_no=$1 FOR NO KEY UPDATE',
      [partition],
    );
    if (!row.rowCount) throw new FollowCountUnavailableError('Missing source partition topology');
    await sampleAndReduce(tx, [partition]);
  });
}

async function sampleAndReduce(tx: Connection, partitions: number[]) {
  if (!partitions.length) return [];
  const { rows } = await tx.query<{ partition_no: number }>(
    `WITH sample AS MATERIALIZED (
       SELECT p.partition_no, p.opened, clock_timestamp() AS sampled_at,
         p.source_complete AND p.target_kind=3 AND c.write_state='active'
         AND NOT EXISTS(SELECT 1 FROM library.follow_count_owner o
           WHERE o.partition_no=p.partition_no AND NOT o.bootstrap_complete
           ORDER BY o.route,o.account_id LIMIT 1) AS covered,
         LEAST((SELECT pending_since FROM library.follow_count_source s
           WHERE s.partition_no=p.partition_no AND pending_since IS NOT NULL
           ORDER BY pending_since,route,account_id,target_type,target_id LIMIT 1),
         (SELECT oldest_pending_at FROM library.follow_count_account_work
           WHERE (route >> 4)=p.partition_no ORDER BY oldest_pending_at,route,account_id LIMIT 1),
         (SELECT oldest_pending_at FROM library.follow_count_terminal_source t
           WHERE t.partition_no=p.partition_no AND NOT local_complete
           ORDER BY oldest_pending_at,account_id LIMIT 1)) AS oldest_pending_at
       FROM library.follow_count_partition p JOIN core.partition c USING(partition_no)
       WHERE p.partition_no=ANY($1::integer[])
     ), opened AS (
       UPDATE library.follow_count_partition p SET opened=true
       FROM sample s WHERE p.partition_no=s.partition_no AND NOT s.opened
         AND s.covered AND s.oldest_pending_at IS NULL
     ), updated AS (
       UPDATE library.follow_count_health h
       SET sampled_at=s.sampled_at, oldest_pending_at=s.oldest_pending_at,
           ready=s.covered AND (s.opened OR s.oldest_pending_at IS NULL)
       FROM sample s WHERE h.node=s.partition_no+$2
       RETURNING h.node-$2 AS partition_no,h.ready,h.oldest_pending_at
     )
     SELECT partition_no FROM updated WHERE NOT ready OR oldest_pending_at IS NOT NULL ORDER BY partition_no`,
    [partitions, FIRST_LEAF],
  );
  let level = partitions.map((partition) => FIRST_LEAF + partition);
  while (level[0] !== 0) {
    level = [...new Set(level.map((node) => Math.floor((node - 1) / FANOUT)))];
    // After acquiring the row locks, take a fresh view of the immediate children.
    await tx.query(
      'SELECT node FROM library.follow_count_health WHERE node=ANY($1::integer[]) ORDER BY node FOR UPDATE',
      [level],
    );
    await tx.query(
      `UPDATE library.follow_count_health parent SET
         sampled_at=child.sampled_at, oldest_pending_at=child.oldest_pending_at, ready=child.ready
       FROM (
         SELECT parent.node, min(h.sampled_at) AS sampled_at, min(h.oldest_pending_at) AS oldest_pending_at,
           bool_and(h.ready AND h.sampled_at IS NOT NULL) AS ready
         FROM unnest($1::integer[]) parent(node)
         JOIN library.follow_count_health h ON h.node BETWEEN parent.node*$2+1 AND parent.node*$2+$2 AND h.members>0
         GROUP BY parent.node
       ) child WHERE parent.node=child.node`,
      [level, FANOUT],
    );
  }
  return rows.map(({ partition_no }) => partition_no);
}
