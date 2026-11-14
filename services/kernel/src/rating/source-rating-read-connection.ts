import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { deadlineClient } from './dependencies.ts';

export type SourceRatingReadClient = ReturnType<typeof deadlineClient>;

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

/** Own one bounded source read, optionally on an anchored repeatable-read snapshot. */
export function withSourceRatingReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: SourceRatingReadClient) => Promise<T>,
  options: { repeatableRead?: boolean } = {},
): Promise<T> {
  const callback = (client: PoolClient) => read(client as SourceRatingReadClient);
  return options.repeatableRead
    ? withBoundedReadOnlyTransaction(pool, deadline, callback, boundedOptions())
    : withBoundedReadConnection(pool, deadline, callback, boundedOptions());
}
