import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
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

/** Bound one Copy-owned checkout and callback to the request's original deadline. */
export function withCopyReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
  options: { transaction?: boolean } = {},
): Promise<T> {
  const callback = (client: PoolClient) => work(client as AccessClient);
  return options.transaction
    ? withBoundedReadOnlyTransaction(pool, deadline, callback, boundedOptions())
    : withBoundedReadConnection(pool, deadline, callback, boundedOptions());
}
