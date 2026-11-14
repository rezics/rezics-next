import type { Pool } from 'pg';
import { withReadConnection } from './read-connection.ts';
import type { AccessClient } from '../request/access.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

/** Keep each Subject discussion source snapshot and its transaction cleanup within the caller's deadline. */
export function withSubjectDiscussionReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withReadConnection(pool, deadline, async (connection) => {
    const { client, discard, retain } = connection;
    let beginAttempted = false;
    try {
      // BEGIN can reach PostgreSQL even when the client never receives its acknowledgement.
      beginAttempted = true;
      await client.query(begin);
      const value = await read(client);
      try {
        await client.query('COMMIT');
        beginAttempted = false;
      } catch (error) {
        // A failed COMMIT has no safe queued rollback, even for a read-only snapshot.
        discard(error);
        throw error;
      }
      return value;
    } catch (error) {
      retain(error);
      if (beginAttempted) {
        if (connection.uncertain || Date.now() >= deadline) {
          discard(error);
        } else {
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
