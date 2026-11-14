import type { Pool } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
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
    isUncertainError: (error: unknown) =>
      !(error instanceof CommandUnavailableError) && classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: (error: unknown) => !(error instanceof CommandUnavailableError),
  };
}

/** Keep author source snapshots on one bounded, deadline-aware connection. */
export function withAuthorReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      await client.query("SET LOCAL statement_timeout = '3000ms'");
      return read(client as AccessClient);
    },
    boundedOptions(),
  );
}
