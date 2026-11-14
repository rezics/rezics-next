import type { Pool } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from './unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

function boundedOptions() {
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error: unknown) {
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
  };
}

/** One released grant-read checkout bounded by the request's original deadline. */
export function withGrantReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadConnection(pool, deadline, read, boundedOptions());
}

/** One read-only repeatable-read snapshot with bounded BEGIN, work, COMMIT and cleanup. */
export function withGrantReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(pool, deadline, read, boundedOptions());
}
