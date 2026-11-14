import type { Pool, PoolClient, QueryConfig } from 'pg';
import { remaining, within } from '../access/deadline.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
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
        client.query = ((query: QueryConfig | string, values?: unknown[]) => {
          if (uncertain) return Promise.reject(failure);
          let dispatched = false;
          let settled = false;
          let nativeFailure: unknown;
          const statement = typeof query === 'string' ? { text: query, values: values ?? [] } : query;
          return within(deadline, () => {
            const queryTimeout = remaining(deadline);
            dispatched = true;
            return raw.query({ ...statement, query_timeout: queryTimeout }).then(
              (result) => {
                settled = true;
                return result;
              },
              (error) => {
                settled = true;
                nativeFailure = error;
                throw error;
              },
            );
          }).catch((error) => {
            if (dispatched && (!settled || !isSettledServerError(nativeFailure))) discard(error);
            throw error;
          });
        }) as AccessClient['query'];

        try {
          return await work({
            client,
            get uncertain() {
              return uncertain;
            },
            discard,
            retain,
          });
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
