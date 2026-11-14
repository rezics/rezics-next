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

/** Own one private Follow snapshot through the request's original deadline. */
export function withFollowDiscoveryReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(
    pool,
    deadline,
    (client: PoolClient) => work(client as AccessClient),
    boundedOptions(),
  );
}
