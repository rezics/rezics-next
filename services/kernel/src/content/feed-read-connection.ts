import type { Pool } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { deadlineClient } from './access-port.ts';

export type FeedReadClient = ReturnType<typeof deadlineClient>;

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
    isUncertainError: (error: unknown) =>
      !(error instanceof CommandUnavailableError) && classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: (error: unknown) => !(error instanceof CommandUnavailableError),
  };
}

/** Own one repeatable-read feed snapshot from checkout through commit or bounded cleanup. */
export function withFeedReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: FeedReadClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(pool, deadline, (client) => read(client as FeedReadClient), boundedOptions());
}
