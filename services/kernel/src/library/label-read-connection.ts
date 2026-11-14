import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

type Isolation = 'REPEATABLE READ' | 'READ COMMITTED';

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error('Label read connection became uncertain');
}

function labelReadError(error: unknown): unknown {
  try {
    throwAccessUnavailable(error);
  } catch (mapped) {
    return mapped;
  }
  return error;
}

/** Own one private Label transaction through the request's original deadline. */
export function withLabelReadConnection<T>(
  pool: Pool,
  deadline: number,
  isolation: Isolation,
  work: (client: AccessClient) => Promise<T>,
): Promise<T> {
  let connection: PoolClient | undefined;
  let transactionOpen = false;
  let transactionUncertain = false;
  let inFlight = 0;
  let hasFailure = false;
  let firstFailure: unknown;
  // Work can reject before a bounded ROLLBACK settles; its error remains the request outcome.
  const remember = (error: unknown) => {
    if (!hasFailure) {
      hasFailure = true;
      firstFailure = labelReadError(error);
    }
  };
  const discard = (error: unknown) => {
    if (connection) discardConnection(connection, errorValue(error));
  };

  return withBoundedReadLifetime(
    (run) =>
      withConnection(pool, (raw) => {
        connection = raw;
        return run(raw);
      }),
    discardConnection,
    deadline,
    async (client) => {
      // Label admission uses FOR SHARE, so retain a writable transaction at the requested isolation.
      const workClient = Object.create(client) as AccessClient;
      const query = client.query;
      workClient.query = ((...args: Parameters<PoolClient['query']>) => {
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

      try {
        transactionUncertain = true;
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        transactionUncertain = false;
        transactionOpen = true;

        let result: T;
        try {
          result = await work(workClient);
        } catch (error) {
          remember(error);
          throw error;
        }
        if (inFlight > 0) {
          const error = new Error('A label read returned with a native query still running');
          discard(error);
          throw error;
        }
        transactionUncertain = true;
        await client.query('COMMIT');
        transactionOpen = false;
        transactionUncertain = false;
        return result;
      } catch (error) {
        remember(error);
        if (transactionOpen && !transactionUncertain) {
          if (inFlight > 0 || Date.now() >= deadline) {
            discard(firstFailure);
          } else {
            transactionUncertain = true;
            try {
              await client.query('ROLLBACK');
              transactionOpen = false;
              transactionUncertain = false;
            } catch (rollbackError) {
              discard(rollbackError);
            }
          }
        } else if (transactionUncertain) {
          discard(firstFailure);
        }
        throw firstFailure;
      }
    },
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError: labelReadError,
      isUncertainError: (error) => classifyUnavailability(error) !== undefined,
      isUncertainSettledQueryError: () => true,
    },
  ).catch((error: unknown) => {
    if (transactionOpen || transactionUncertain || inFlight > 0) discard(hasFailure ? firstFailure : error);
    if (hasFailure) throw firstFailure;
    throw error;
  });
}
