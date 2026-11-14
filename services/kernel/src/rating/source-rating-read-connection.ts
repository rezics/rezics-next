import type { Pool, PoolClient } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './dependencies.ts';

export type SourceRatingReadClient = ReturnType<typeof deadlineClient>;

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/** Own one bounded source read, optionally on an anchored repeatable-read snapshot. */
export function withSourceRatingReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: SourceRatingReadClient) => Promise<T>,
  options: { repeatableRead?: boolean } = {},
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
      let transaction: 'none' | 'beginning' | 'open' | 'committing' | 'committed' = 'none';
      try {
        if (options.repeatableRead) {
          transaction = 'beginning';
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          transaction = 'open';
        }
        const result = await within(deadline, () => read(client));
        if (transaction === 'open') {
          transaction = 'committing';
          await client.query('COMMIT');
          transaction = 'committed';
        }
        return result;
      } catch (error) {
        const reason = classifyUnavailability(error);
        if (
          inFlight.size > 0 ||
          transaction === 'beginning' ||
          transaction === 'committing' ||
          reason === 'deadline' ||
          reason === 'overloaded'
        ) {
          discardConnection(connection, asError(error, 'Source rating read connection became uncertain'));
        } else if (transaction === 'open') {
          try {
            await within(deadline, () => client.query('ROLLBACK'));
          } catch (rollbackError) {
            discardConnection(connection, asError(rollbackError, 'Source rating read rollback failed'));
          }
        }
        throw error;
      }
    }),
  );
}
