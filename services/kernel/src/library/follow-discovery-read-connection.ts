import type { Pool, PoolClient } from 'pg';
import { deadlineClient, within } from './access-port.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error('Follow discovery read connection became uncertain');
}

/** Own one private Follow snapshot through the request's original deadline. */
export function withFollowDiscoveryReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      let inFlight = 0;
      const query = connection.query;
      connection.query = ((...args: Parameters<PoolClient['query']>) => {
        inFlight += 1;
        let dispatched: ReturnType<PoolClient['query']>;
        try {
          dispatched = Reflect.apply(query, connection, args) as ReturnType<PoolClient['query']>;
        } catch (error) {
          inFlight -= 1;
          throw error;
        }
        return Promise.resolve(dispatched).finally(() => {
          inFlight -= 1;
        });
      }) as PoolClient['query'];

      const client = deadlineClient(connection, deadline);
      let transactionOpen = false;
      const discard = (error: unknown) => discardConnection(connection, errorValue(error));
      try {
        try {
          await client.query(BEGIN);
          transactionOpen = true;
        } catch (error) {
          discard(error);
          throw error;
        }

        const result = await within(deadline, () => work(client));
        try {
          await client.query('COMMIT');
          transactionOpen = false;
        } catch (error) {
          transactionOpen = false;
          discard(error);
          throw error;
        }
        return result;
      } catch (error) {
        if (inFlight > 0 || (transactionOpen && Date.now() >= deadline)) {
          discard(error);
          throw error;
        }
        if (transactionOpen) {
          try {
            await client.query('ROLLBACK');
            transactionOpen = false;
          } catch (rollbackError) {
            discard(rollbackError);
          }
        }
        throw error;
      }
    }),
  );
}
