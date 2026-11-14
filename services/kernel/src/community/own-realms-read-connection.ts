import type { Pool, PoolClient } from 'pg';
import { deadlineClient, within } from '../access/deadline.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

/** A repeatable-read snapshot whose checkout, statements and cleanup share one deadline. */
export function withOwnRealmsReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const inFlight = new Set<Promise<unknown>>();
      const query = connection.query;
      connection.query = ((...args: unknown[]) => {
        const pending = Reflect.apply(query, connection, args) as Promise<unknown>;
        inFlight.add(pending);
        void pending.then(
          () => inFlight.delete(pending),
          () => inFlight.delete(pending),
        );
        return pending;
      }) as PoolClient['query'];

      const client = deadlineClient(connection, deadline);
      let transactionStarted = false;
      let commitStarted = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        transactionStarted = true;
        const result = await within(deadline, () => read(client));
        commitStarted = true;
        await client.query('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        const reason = classifyUnavailability(error);
        if (commitStarted || inFlight.size > 0 || reason === 'deadline' || reason === 'overloaded') {
          discardConnection(
            connection,
            error instanceof Error ? error : new Error('Own Realm read connection became uncertain'),
          );
        } else if (transactionStarted) {
          try {
            await within(deadline, () => client.query('ROLLBACK'));
          } catch (rollbackError) {
            discardConnection(
              connection,
              rollbackError instanceof Error ? rollbackError : new Error('Own Realm read rollback failed'),
            );
          }
        }
        throw error;
      }
    }),
  );
}
