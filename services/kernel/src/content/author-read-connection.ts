import type { Pool, PoolClient } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { deadlineClient, within } from './access-port.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

/** Keep author source snapshots on one bounded, deadline-aware connection. */
export function withAuthorReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const inFlight = new Set<Promise<unknown>>();
      const query = connection.query;
      connection.query = ((...args: unknown[]) => {
        const result = Reflect.apply(query, connection, args) as Promise<unknown>;
        inFlight.add(result);
        void result.then(
          () => inFlight.delete(result),
          () => inFlight.delete(result),
        );
        return result;
      }) as PoolClient['query'];

      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const result = await within(deadline, () => read(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        const reason = error instanceof CommandUnavailableError ? undefined : classifyUnavailability(error);
        if (inFlight.size > 0 || reason === 'deadline' || reason === 'overloaded') {
          discardConnection(
            connection,
            error instanceof Error ? error : new Error('Author read connection became uncertain'),
          );
        } else {
          try {
            await within(deadline, () => connection.query('ROLLBACK'));
          } catch (rollbackError) {
            discardConnection(
              connection,
              rollbackError instanceof Error ? rollbackError : new Error('Author read rollback failed'),
            );
          }
        }
        throw error;
      }
    }),
  );
}
