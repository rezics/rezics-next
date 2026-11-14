import type { Pool } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

function boundedOptions() {
  const isNoticeTransportFailure = (error: unknown) => {
    const reason = classifyUnavailability(error);
    return reason === 'deadline' || reason === 'overloaded';
  };
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error: unknown) {
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: isNoticeTransportFailure,
    isUncertainWorkError: isNoticeTransportFailure,
  };
}

/** Keep inbox source reads on one checkout, bounded by the deadline for the whole visit. */
export function withNoticeInboxReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
  options: { repeatableRead?: boolean } = {},
): Promise<T> {
  return options.repeatableRead
    ? withBoundedReadOnlyTransaction(pool, deadline, read, boundedOptions())
    : withBoundedReadConnection(pool, deadline, read, boundedOptions());
}
