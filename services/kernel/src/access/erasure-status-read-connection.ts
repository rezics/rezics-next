import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from './unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

function boundedOptions() {
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error: unknown) {
      if (error instanceof CommandUnavailableError) return error;
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: () => true,
  };
}

/** One checkout owned by the original managed erasure read deadline. */
export function withErasureStatusReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient, connection: PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadConnection(pool, deadline, (client) => read(client as AccessClient, client), boundedOptions());
}

/** Read-only snapshot with bounded BEGIN, COMMIT, and rollback cleanup. */
export function withErasureStatusReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(pool, deadline, (client) => read(client as AccessClient), boundedOptions());
}
