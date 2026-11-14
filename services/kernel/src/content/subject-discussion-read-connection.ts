import type { Pool } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
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

/** Keep each Subject discussion source snapshot and its transaction cleanup within the caller's deadline. */
export function withSubjectDiscussionReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  let readFailed = false;
  let readFailure: unknown;
  const snapshot = withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      try {
        return await read(client as AccessClient);
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
