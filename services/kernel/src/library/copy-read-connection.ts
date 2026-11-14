import type { Pool, PoolClient } from 'pg';
import { deadlineClient, remaining, within } from '../access/deadline.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error('Copy read connection became uncertain');
}

/** Bound one Copy-owned checkout and callback to the request's original deadline. */
export function withCopyReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
  options: { transaction?: boolean } = {},
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (client) => {
      let inFlight = 0;
      const query = client.query;
      client.query = ((...args: Parameters<PoolClient['query']>) => {
        inFlight += 1;
        let dispatched: ReturnType<PoolClient['query']>;
        try {
          dispatched = Reflect.apply(query, client, args) as ReturnType<PoolClient['query']>;
        } catch (error) {
          inFlight -= 1;
          throw error;
        }
        return Promise.resolve(dispatched).finally(() => {
          inFlight -= 1;
        });
      }) as PoolClient['query'];

      const bounded = deadlineClient(client, deadline);
      let transactionOpen = false;
      const discard = (error: unknown) => discardConnection(client, errorValue(error));
      try {
        remaining(deadline);
        if (options.transaction) {
          try {
            await bounded.query(BEGIN);
            transactionOpen = true;
          } catch (error) {
            discard(error);
            throw error;
          }
        }

        const result = await within(deadline, () => work(bounded));
        if (options.transaction) {
          try {
            await bounded.query('COMMIT');
            transactionOpen = false;
          } catch (error) {
            transactionOpen = false;
            discard(error);
            throw error;
          }
        }
        return result;
      } catch (error) {
        if (inFlight > 0 || (transactionOpen && Date.now() >= deadline)) {
          discard(error);
          throw error;
        }
        if (transactionOpen) {
          try {
            await bounded.query('ROLLBACK');
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
