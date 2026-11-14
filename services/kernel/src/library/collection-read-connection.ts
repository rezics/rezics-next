import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';

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

function withCollectionRead<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
  snapshot: boolean,
): Promise<T> {
  let workFailed = false;
  let workFailure: unknown;
  const read = async (client: PoolClient) => {
    try {
      return await work(client);
    } catch (error) {
      workFailed = true;
      workFailure = error;
      throw error;
    }
  };
  const result = snapshot
    ? withBoundedReadOnlyTransaction(pool, deadline, read, boundedOptions())
    : withBoundedReadConnection(pool, deadline, read, boundedOptions());
  return result.catch((error: unknown) => {
    if (workFailed) throw workFailure;
    throw error;
  });
}

/** A deadline-bounded checkout and query client that retains pool accounting and cleanup custody. */
export function withCollectionReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCollectionRead(pool, deadline, work, false);
}

/** One repeatable-read snapshot whose transaction controls share the visit deadline. */
export function withCollectionReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCollectionRead(pool, deadline, work, true);
}
