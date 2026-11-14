import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';

/** One repeatable-read snapshot with the request deadline on checkout, SQL and cleanup. */
export function withCollectionDiscoveryReadSnapshot<T>(
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
