import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';

/** A deadline-bounded repeatable-read snapshot for Continue owner reads. */
export function withContinueReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(pool, deadline, work, {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error) {
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error) => classifyUnavailability(error) !== undefined,
  });
}
