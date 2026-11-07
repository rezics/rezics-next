import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/deadline.ts';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

export { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable };
export { withRequestDeadline };

const snapshots = new AsyncLocalStorage<ReadonlyMap<Pool, { client: PoolClient; deadline: number; live: boolean }>>();

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
  return withConnection(pool, async (connection) => {
    // Keep the native client lifetime/discard owner; all queries use its real connection
    // with the original request's remaining budget, including native Access queries.
    const client = deadlineClient(connection, deadline) as PoolClient;
    const snapshot = { client, deadline, live: true };
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      requireAccessDeadline(deadline);
      const remaining = Math.max(1, Math.floor(deadline - Date.now()));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      const next = new Map(snapshots.getStore());
      next.set(pool, snapshot);
      const result = await snapshots.run(next, () => read(client));
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
      requireAccessDeadline(deadline);
      return result;
    } catch (error) {
      try {
        // Cleanup must still run after the request expires.
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      requireAccessDeadline(deadline);
      throw error;
    } finally {
      snapshot.live = false;
    }
  });
}
