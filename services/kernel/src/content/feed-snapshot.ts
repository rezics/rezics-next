import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';

/** Exactly one backend/home snapshot, released before any other home is entered. */
export function feedSnapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: ReturnType<typeof deadlineClient>) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const home = await readPartition(client, partitionOf(route));
        if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const result = await read(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }),
  );
}
