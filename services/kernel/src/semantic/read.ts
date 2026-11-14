import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/deadline.ts';
import {
  AccessUnavailableError,
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

export { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable };
export { withRequestDeadline };

const snapshots = new AsyncLocalStorage<ReadonlyMap<Pool, { client: PoolClient; deadline: number; live: boolean }>>();

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

/** Only this executor's live checked-out RR clients qualify; a pool.query facade never does. */
export function currentReadSnapshot(pool: Pool): PoolClient | undefined {
  const snapshot = snapshots.getStore()?.get(pool);
  return snapshot?.live ? snapshot.client : undefined;
}

/** One physical-pool snapshot across independently bound logical partition reads. */
export function withReadTransaction<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
  requestDeadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
): Promise<T> {
  const inherited = snapshots.getStore()?.get(pool);
  const owned = inherited?.live ? inherited : undefined;
  const deadline = Math.min(requestDeadline, owned?.deadline ?? Infinity);
  requireAccessDeadline(deadline);
  if (owned) {
    return (async () => {
      const client = deadline < owned.deadline ? (deadlineClient(owned.client, deadline) as PoolClient) : owned.client;
      const result = await read(client);
      requireAccessDeadline(deadline);
      return result;
    })();
  }
  let snapshot: { client: PoolClient; deadline: number; live: boolean } | undefined;
  const visit = withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      requireAccessDeadline(deadline);
      const remaining = Math.max(1, Math.floor(deadline - Date.now()));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      requireAccessDeadline(deadline);
      const ownedSnapshot = { client, deadline, live: true };
      snapshot = ownedSnapshot;
      const next = new Map(snapshots.getStore());
      next.set(pool, ownedSnapshot);
      try {
        return await snapshots.run(next, () => read(client));
      } finally {
        ownedSnapshot.live = false;
      }
    },
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError(error) {
        try {
          throwAccessUnavailable(error, deadline);
        } catch (mapped) {
          return mapped;
        }
        return error;
      },
      isUncertainError: (error) => classifyUnavailability(error) !== undefined,
      isUncertainSettledQueryError: (error) => !isSettledServerError(error),
    },
  );
  return visit.finally(() => {
    if (snapshot) snapshot.live = false;
  });
}
