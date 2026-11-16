import type { Pool } from 'pg';
import type { AccessClient } from '../../request/access.ts';
import { AccessUnavailableError } from '../../access/contract/errors.ts';
import { withBoundedReadLifetime } from '../../database/bounded-read-lifetime.ts';
import { discardConnection, retireConnection, withConnection } from '../../database/pool.ts';
import { readConsumerLag } from '../../events/consumer-lag.ts';
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

/** Borrowed Follow reads retain the original deadline through checkout and every query.
 * A late checkout dispatches no SQL. A rejected callback discards its borrowed socket
 * before release. Expiry retires an active socket even when the read callback
 * has yet to settle. */
export function withFollowCountReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadLifetime(
    (run) =>
      withConnection(pool, async (connection) => {
        try {
          return await run(connection);
        } catch (error) {
          discardConnection(connection, error instanceof Error ? error : new Error('Follow count read failed'));
          throw error;
        }
      }),
    retireConnection,
    deadline,
    read,
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      isUncertainWorkError: () => true,
      isUncertainSettledQueryError: () => true,
    },
  );
}

export function requireFollowCountHealth(pool: Pool, deadline: number): Promise<FollowCountHealthObservation> {
  return withFollowCountReadConnection(pool, deadline, readFollowCountHealthObservation);
}
