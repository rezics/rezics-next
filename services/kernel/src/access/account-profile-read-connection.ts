import type { Pool, PoolClient } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './deadline.ts';
import { classifyUnavailability, requireAccessDeadline } from './unavailable.ts';
import {
  AccessWorkUnavailableError,
  accessCheckout,
  accessTransaction,
  type AccessWorkAccounting,
} from './work.ts';

type TransactionControl = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' | 'COMMIT' | 'ROLLBACK';

function asDiscardError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Account profile read connection failed');
}

function uncertain(error: unknown, deadline: number): boolean {
  if (Date.now() >= deadline || classifyUnavailability(error) === 'deadline') return true;
  return classifyUnavailability(error) === 'overloaded' && !(error instanceof AccessWorkUnavailableError());
}

/** One bounded checkout for the private profile and rename-entry sources. */
export function withAccountProfileReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient, connection: PoolClient) => Promise<T>,
  work?: AccessWorkAccounting,
): Promise<T> {
  let acquired = false;
  let active: PoolClient | undefined;
  const operation = accessCheckout(work, () =>
    withConnection(pool, async (connection) => {
      // A checkout that completes after the request expires must return without SQL.
      requireAccessDeadline(deadline);
      acquired = true;
      active = connection;
      const client = deadlineClient(connection, deadline);
      try {
        // Callers use deadlineClient for native reads; snapshot callbacks also
        // bound their full body so this wrapper can wait for cleanup to finish.
        const result = await read(client, connection);
        requireAccessDeadline(deadline);
        return result;
      } catch (error) {
        if (uncertain(error, deadline)) discardConnection(connection, asDiscardError(error));
        throw error;
      } finally {
        active = undefined;
      }
    }),
  );

  return (async () => {
    try {
      return await within(deadline, () => operation);
    } catch (error) {
      // If the request timer won the race, let the bounded callback unwind so
      // withConnection releases the client before this visit returns.
      let finalError = error;
      if (acquired) {
        if (active && uncertain(error, deadline)) discardConnection(active, asDiscardError(error));
        try {
          await operation;
        } catch (operationError) {
          // Cleanup can reach the deadline after a source error; keep that primary error.
          finalError = operationError;
        }
      }
      throw finalError;
    }
  })();
}

/** Read-only snapshot with bounded BEGIN, COMMIT and rollback cleanup. */
export function withAccountProfileReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
  work?: AccessWorkAccounting,
): Promise<T> {
  return withAccountProfileReadConnection(
    pool,
    deadline,
    async (client, connection) => {
      let transactionOpen = false;
      let transactionUncertain = false;
      let currentControl: TransactionControl | undefined;
      let controlDispatched = false;
      const controlClient = Object.create(client) as AccessClient;
      const query = client.query.bind(client);
      controlClient.query = ((...args: unknown[]) => {
        requireAccessDeadline(deadline);
        if (currentControl) controlDispatched = true;
        return Reflect.apply(query, client, args);
      }) as AccessClient['query'];

      const control = async (statement: TransactionControl) => {
        currentControl = statement;
        controlDispatched = false;
        try {
          await within(deadline, async () => {
            requireAccessDeadline(deadline);
            if (work) await accessTransaction(work, controlClient, statement);
            else await controlClient.query(statement);
          });
        } catch (error) {
          if (controlDispatched || uncertain(error, deadline)) {
            transactionUncertain = true;
            discardConnection(connection, asDiscardError(error));
          }
          throw error;
        } finally {
          currentControl = undefined;
        }
      };

      try {
        await control('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        transactionOpen = true;
        const result = await within(deadline, () => read(controlClient));
        requireAccessDeadline(deadline);
        await control('COMMIT');
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen && !transactionUncertain) {
          try {
            requireAccessDeadline(deadline);
            await control('ROLLBACK');
            transactionOpen = false;
          } catch (rollbackError) {
            discardConnection(connection, asDiscardError(rollbackError));
          }
        }
        throw error;
      }
    },
    work,
  );
}
