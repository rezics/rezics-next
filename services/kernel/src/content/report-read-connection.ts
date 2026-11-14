import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { withReadConnection } from './read-connection.ts';

/** Keep a complete report read transaction inside its original request deadline. */
export function withReportReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withReadConnection(pool, deadline, async ({ client, uncertain, discard, retain }) => {
    let beginAttempted = false;
    try {
      beginAttempted = true;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await read(client);
      await client.query('COMMIT');
      beginAttempted = false;
      return value;
    } catch (error) {
      retain(error);
      if (beginAttempted) {
        if (uncertain) discard(error);
        else {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discard(rollbackError);
          }
        }
      }
      throw error;
    }
  });
}
