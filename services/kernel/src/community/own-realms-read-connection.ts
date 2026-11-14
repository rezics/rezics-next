import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

function boundedOptions() {
  const uncertain = (error: unknown) => {
    const reason = classifyUnavailability(error);
    return reason === 'deadline' || reason === 'overloaded';
  };
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
    isUncertainError: uncertain,
    isUncertainSettledQueryError: () => true,
    isUncertainWorkError: uncertain,
  };
}

/** A repeatable-read snapshot whose checkout, statements and cleanup share one deadline. */
export function withOwnRealmsReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(pool, deadline, (client) => read(client as AccessClient), boundedOptions());
}
