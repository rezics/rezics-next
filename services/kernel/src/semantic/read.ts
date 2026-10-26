import type { Pool, PoolClient } from 'pg';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';

/** Keep a semantic read's snapshot and statements within the shared request budget. */
export function withReadTransaction<T>(pool: Pool, read: (client: PoolClient) => Promise<T>): Promise<T> {
  const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let result: T;
    try {
      requireAccessDeadline(deadline);
      const remaining = Math.max(1, Math.floor(deadline - Date.now()));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      requireAccessDeadline(deadline);
      result = await read(client);
      requireAccessDeadline(deadline);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      requireAccessDeadline(deadline);
      throw error;
    }
    requireAccessDeadline(deadline);
    return result;
  });
}
