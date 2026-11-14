import type { Pool } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';
import { within } from './access-port.ts';
import { withReadConnection } from './read-connection.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

function discardError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
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

  return withReadConnection(pool, deadline, async ({ client, uncertain, discard, retain }) => {
    let open = false;
    try {
      await client.query(begin);
      open = true;
      const value = await within(deadline, () => read(client));
      await client.query('COMMIT');
      open = false;
      return value;
    } catch (error) {
      retain(error);
      if (uncertain) discard(error);
      else if (open) {
        try {
          await client.query('ROLLBACK');
          open = false;
        } catch (rollbackError) {
          discard(rollbackError);
        }
      }
      throw error;
    }
  });
}
