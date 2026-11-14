import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';

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

/** Runs private entry reads in one deadline-bounded repeatable-read snapshot. */
export function withEntryPersonalReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let readFailed = false;
  let readFailure: unknown;
  const snapshot = withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client: PoolClient) => {
      try {
        return await read(client);
      } catch (error) {
        readFailed = true;
        readFailure = error;
        throw error;
      }
    },
    boundedOptions(),
  );
  return snapshot.catch((error: unknown) => {
    if (readFailed) throw readFailure;
    throw error;
  });
}
