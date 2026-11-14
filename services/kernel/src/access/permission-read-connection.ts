import type { Pool, QueryConfig } from 'pg';
import type { AccessClient } from './check.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { AccessUnavailableError, classifyUnavailability } from './unavailable.ts';

function readFailure(error: unknown): AccessUnavailableError {
  if (error instanceof AccessUnavailableError) return error;
  const reason = classifyUnavailability(error);
  const failure = new AccessUnavailableError(
    reason === 'deadline' || reason === 'contention' ? reason : 'overloaded',
  );
  Object.defineProperty(failure, 'cause', { value: error, configurable: true, writable: true });
  return failure;
}

/** Transport only: the public primitive owns checkout, retirement and release.
 * Keep native SQL failures distinct from the owner's authorization denials.
 * Work declarations and explicit checkout charges remain at their call sites.
 */
export function withPermissionReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  let acquired = false;
  return withBoundedReadConnection(
    pool,
    deadline,
    (client) => {
      acquired = true;
      const transport = Object.create(client) as AccessClient;
      transport.query = (async (query: QueryConfig | string, values?: unknown[]) => {
        try {
          return await client.query(query, values);
        } catch (error) {
          throw readFailure(error);
        }
      }) as AccessClient['query'];
      return read(transport);
    },
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      isUncertainSettledQueryError: () => true,
    },
  ).catch((error: unknown) => {
    // Callback failures keep their original identity; failed acquisition is IO.
    throw acquired ? error : readFailure(error);
  });
}

/** Each statement observes its source on an independently released connection. */
export function permissionReadClient(pool: Pool, deadline: number): AccessClient {
  const transport = Object.create(pool) as AccessClient;
  transport.query = ((query: QueryConfig | string, values?: unknown[]) =>
    withPermissionReadConnection(pool, deadline, (client) => client.query(query, values))) as AccessClient['query'];
  return transport;
}
