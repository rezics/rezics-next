import type { Pool, PoolClient } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';
import { deadlineClient, within } from './access-port.ts';

type Control = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' | 'COMMIT' | 'ROLLBACK';

function uncertain(error: unknown, deadline: number): boolean {
  if (Date.now() >= deadline) return true;
  const reason = classifyUnavailability(error);
  return reason === 'deadline' || reason === 'overloaded';
}

function discardError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Uploader inventory read failed');
}

/** Keep each uploader-inventory snapshot inside its original request deadline. */
export function withOwnMediaReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  let active: PoolClient | undefined;
  const operation = withConnection(pool, async (connection) => {
    active = connection;
    let transactionOpen = false;
    let transactionUncertain = false;
    let trackingControl = false;
    let controlDispatched = false;

    const native = Object.create(connection) as AccessClient;
    const query = connection.query.bind(connection);
    native.query = ((...args: unknown[]) => {
      if (trackingControl) controlDispatched = true;
      return Reflect.apply(query, connection, args);
    }) as AccessClient['query'];
    const client = deadlineClient(native, deadline);

    const control = async (statement: Control) => {
      trackingControl = true;
      controlDispatched = false;
      try {
        await within(deadline, () => client.query(statement));
      } catch (error) {
        if (controlDispatched || (transactionOpen && uncertain(error, deadline))) {
          transactionUncertain = true;
          discardConnection(connection, discardError(error));
        }
        throw error;
      } finally {
        trackingControl = false;
      }
    };

    try {
      await control('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionOpen = true;
      const result = await within(deadline, () => read(client));
      await control('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen && !transactionUncertain && !uncertain(error, deadline)) {
        try {
          await control('ROLLBACK');
          transactionOpen = false;
        } catch (rollbackError) {
          discardConnection(connection, discardError(rollbackError));
        }
      } else if (transactionOpen || transactionUncertain) {
        discardConnection(connection, discardError(error));
      }
      throw error;
    } finally {
      active = undefined;
    }
  });

  return within(deadline, () => operation).catch((error) => {
    if (active && uncertain(error, deadline)) discardConnection(active, discardError(error));
    throw error;
  });
}
