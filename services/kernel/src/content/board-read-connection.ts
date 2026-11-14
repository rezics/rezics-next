import type { Pool } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { discardConnection, withBoundedReadOnlyTransaction, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function discardError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

/** Run a Board fact snapshot on one checkout, keeping visitor reads inside their original deadline. */
export function withBoardReadSnapshot<T>(
  pool: Pool,
  deadline: number | undefined,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  if (deadline === undefined) {
    return withConnection(pool, async (connection) => {
      let open = false;
      try {
        try {
          await connection.query(begin);
          open = true;
        } catch (error) {
          // BEGIN may have reached PostgreSQL even when its result is unavailable.
          discardConnection(connection, discardError(error, 'Board read BEGIN failed'));
          throw error;
        }
        const value = await read(connection);
        try {
          await connection.query('COMMIT');
          open = false;
        } catch (error) {
          discardConnection(connection, discardError(error, 'Board read COMMIT failed'));
          open = false;
          throw error;
        }
        return value;
      } catch (error) {
        if (open) {
          try {
            await connection.query('ROLLBACK');
            open = false;
          } catch (rollbackError) {
            discardConnection(connection, discardError(rollbackError, 'Board read rollback failed'));
            open = false;
          }
        }
        throw error;
      }
    });
  }

  return withBoundedReadOnlyTransaction(pool, deadline, read, {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error) {
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error) => classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: (error) => !isSettledServerError(error),
  });
}
