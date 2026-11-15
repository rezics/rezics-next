import type { Pool, PoolClient, QueryConfig } from 'pg';
import { remaining, within } from '../access/deadline.ts';
import { discardConnection, withConnection, type NativeReadQueryConfig } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

export type ReadConnection = Readonly<{
  client: AccessClient;
  readonly uncertain: boolean;
  discard(error: unknown): void;
  retain(error: unknown): void;
}>;

function releaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Content read connection could not be reused');
}

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

/** Bound checkout, every native query and release to one read deadline. */
export async function withReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (connection: ReadConnection) => Promise<T>,
): Promise<T> {
  let connection: PoolClient | undefined;
  let active = false;
  let activeQueries = 0;
  let uncertain = false;
  let failure: unknown;
  let retainedError: unknown;
  let hasRetainedError = false;
  const discard = (error: unknown) => {
    if (!uncertain) {
      uncertain = true;
      failure = error;
    }
    if (connection) discardConnection(connection, releaseError(failure));
  };
  const retain = (error: unknown) => {
    if (!hasRetainedError) {
      retainedError = error;
      hasRetainedError = true;
    }
  };

  try {
    return await within(deadline, () =>
      withConnection(pool, async (raw) => {
        connection = raw;
        active = true;
        const client = Object.create(raw) as AccessClient;
        client.query = ((query: QueryConfig | string, valuesOrCallback?: unknown, callbackArgument?: unknown) => {
          const callback = typeof valuesOrCallback === 'function' ? valuesOrCallback : callbackArgument;
          const completeWithCallback = (completion: Promise<unknown>) => {
            if (typeof callback !== 'function') return completion;
            void completion.then(
              (result) => Reflect.apply(callback, undefined, [null, result]),
              (error: unknown) => Reflect.apply(callback, undefined, [error]),
            );
            return undefined;
          };
          if (uncertain) return completeWithCallback(Promise.reject(failure));
          let dispatched = false;
          let settled = false;
          let nativeFailure: unknown;
          const values = Array.isArray(valuesOrCallback) ? valuesOrCallback : undefined;
          const statement: NativeReadQueryConfig =
            typeof query === 'string'
              ? { text: query, ...(values === undefined ? {} : { values }) }
              : { ...query, ...(values === undefined ? {} : { values }) };
          const completion = within(deadline, () => {
            const queryTimeout = remaining(deadline);
            dispatched = true;
            activeQueries += 1;
            if (statement.query_timeout === undefined) statement.query_timeout = queryTimeout;
            else if (statement.query_timeout > 0)
              statement.query_timeout = Math.min(statement.query_timeout, queryTimeout);
            let request: Promise<unknown>;
            try {
              request = Promise.resolve(Reflect.apply(raw.query, raw, [statement]));
            } catch (error) {
              settled = true;
              activeQueries -= 1;
              nativeFailure = error;
              throw error;
            }
            return request.then(
              (result) => {
                settled = true;
                activeQueries -= 1;
                return result;
              },
              (error) => {
                settled = true;
                activeQueries -= 1;
                nativeFailure = error;
                throw error;
              },
            );
          }).catch((error) => {
            if (dispatched && (!settled || !isSettledServerError(nativeFailure))) discard(error);
            throw error;
          });
          return completeWithCallback(completion);
        }) as AccessClient['query'];

        try {
          const result = await work({
            client,
            get uncertain() {
              return uncertain;
            },
            discard,
            retain,
          });
          if (activeQueries > 0) {
            const error = new Error('A content read returned with a native query still running');
            discard(error);
            throw error;
          }
          return result;
        } finally {
          active = false;
          connection = undefined;
        }
      }),
    );
  } catch (error) {
    const result = hasRetainedError ? retainedError : error;
    if (connection && active) discard(error);
    throw result;
  }
}
