import type { Pool } from 'pg';
import type { AccessClient } from '../../request/access.ts';
import { discardConnection, withConnection } from '../../database/pool.ts';
import { readConsumerLag } from '../../events/consumer-lag.ts';
import { deadlineClient, within } from '../access-port.ts';
import { followCountHealthCurrent } from '../core/index.ts';
import { FollowCountUnavailableError, type FollowCountHealthObservation } from '../contract/index.ts';
export type { FollowCountHealthObservation } from '../contract/index.ts';

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
  const lag = await readConsumerLag(tx, 'effects');
  if (
    !followCountHealthCurrent({
      now: Date.parse(row.now),
      sampledAt: Date.parse(row.sampled_at),
      oldestPendingAt: row.oldest_pending_at === null ? null : Date.parse(row.oldest_pending_at),
      consumer: lag
        ? { observedAt: lag.observedAt.getTime(), oldestPendingAt: lag.oldestPendingAt?.getTime() ?? null }
        : null,
    })
  )
    throw new FollowCountUnavailableError();
  return {
    sampledAt: row.sampled_at,
    oldestPendingAt: row.oldest_pending_at,
    consumerObservedAt: lag!.observedAt.toISOString(),
    consumerOldestPendingAt: lag!.oldestPendingAt?.toISOString() ?? null,
  };
}

/** Autocommit count reads retain the original deadline, including checkout wait.
 * Every query checks expiry before dispatch, including after a late checkout.
 * A rejected query may still have native IO in flight: mark its borrowed socket
 * for discard before withConnection releases it, without queuing a rollback.
 * Caller-owned snapshots do not pass through this borrowed-client boundary. */
export function withFollowCountReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
  timing: { deadlineClient: typeof deadlineClient; within: typeof within } = { deadlineClient, within },
): Promise<T> {
  return timing.within(deadline, () =>
    withConnection(pool, async (connection) => {
      try {
        return await read(timing.deadlineClient(connection, deadline));
      } catch (error) {
        discardConnection(connection, error as Error);
        throw error;
      }
    }),
  );
}

export function requireFollowCountHealth(pool: Pool, deadline: number): Promise<FollowCountHealthObservation> {
  return withFollowCountReadConnection(pool, deadline, readFollowCountHealthObservation);
}
