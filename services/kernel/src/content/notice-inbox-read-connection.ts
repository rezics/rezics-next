import type { Pool, PoolClient } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { deadlineClient, within } from './access-port.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

/** Keep inbox source reads on one checkout, bounded by the deadline for the whole visit. */
export function withNoticeInboxReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
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
          discardConnection(
            connection,
            error instanceof Error ? error : new Error('Notice inbox read connection became uncertain'),
          );
        } else if (transaction === 'open') {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(
              connection,
              rollbackError instanceof Error ? rollbackError : new Error('Notice inbox read rollback failed'),
            );
          }
        }
        throw error;
      }
    }),
  );
}
