import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError, classifyUnavailability } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './access-port.ts';

export type FeedReadClient = ReturnType<typeof deadlineClient>;

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/** Own one repeatable-read feed snapshot from checkout through commit or bounded cleanup. */
export function withFeedReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: FeedReadClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const inFlight = new Set<Promise<unknown>>();
      const query = connection.query;
      connection.query = ((...args: unknown[]) => {
        const result = Reflect.apply(query, connection, args) as Promise<unknown>;
        inFlight.add(result);
        void result.then(
          () => inFlight.delete(result),
          () => inFlight.delete(result),
        );
        return result;
      }) as PoolClient['query'];

      const client = deadlineClient(connection, deadline);
      let beginAttempted = false;
      try {
        beginAttempted = true;
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await within(deadline, () => read(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        const reason = error instanceof CommandUnavailableError ? undefined : classifyUnavailability(error);
        if (inFlight.size > 0 || reason === 'deadline' || reason === 'overloaded') {
          discardConnection(connection, asError(error, 'Feed read connection became uncertain'));
        } else if (beginAttempted) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, asError(rollbackError, 'Feed read rollback failed'));
          }
        }
        throw error;
      }
    }),
  );
}
