import type { Pool, PoolClient, QueryConfig } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { remaining, within } from './deadline.ts';
import { AccessUnavailableError, classifyUnavailability, requireAccessDeadline } from './unavailable.ts';

type ManagedConnection = Readonly<{
  client: AccessClient;
  uncertain: () => boolean;
  discard: (error: unknown) => void;
}>;

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function connectionForRead(connection: PoolClient, deadline: number): ManagedConnection {
  let uncertainty: Error | undefined;
  const discard = (error: unknown) => {
    uncertainty ??= asError(error);
    discardConnection(connection, uncertainty);
  };
  const client = Object.create(connection) as AccessClient;
  client.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const queryTimeout = remaining(deadline);
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: queryTimeout,
    };
    const native = Reflect.apply(connection.query, connection, [config]) as Promise<unknown>;
    let settled = false;
    const observed = native.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    return within(deadline, () => observed).catch((error: unknown) => {
      const reason = classifyUnavailability(error);
      if (!settled || Date.now() >= deadline || reason === 'deadline' || reason === 'overloaded') discard(error);
      throw error;
    });
  }) as AccessClient['query'];
  return { client, uncertain: () => uncertainty !== undefined, discard };
}

async function withManagementConnection<T>(
  pool: Pool,
  deadline: number,
  work: (connection: ManagedConnection) => Promise<T>,
): Promise<T> {
  requireAccessDeadline(deadline);
  let cancelled = false;
  let announceCheckout!: () => void;
  let failCheckout!: (error: unknown) => void;
  let startWork!: () => void;
  const checkoutReady = new Promise<void>((resolve, reject) => {
    announceCheckout = resolve;
    failCheckout = reject;
  });
  const workMayStart = new Promise<void>((resolve) => (startWork = resolve));
  const operation = withConnection(pool, async (native) => {
    const managed = connectionForRead(native, deadline);
    // A late checkout is returned without sending SQL.
    requireAccessDeadline(deadline);
    if (cancelled) throw new AccessUnavailableError('deadline');
    announceCheckout();
    await workMayStart;
    if (cancelled) throw new AccessUnavailableError('deadline');
    try {
      const result = await work(managed);
      requireAccessDeadline(deadline);
      return result;
    } catch (error) {
      const reason = classifyUnavailability(error);
      if (
        managed.uncertain() ||
        Date.now() >= deadline ||
        reason === 'deadline' ||
        reason === 'overloaded'
      )
        managed.discard(error);
      throw error;
    }
  });
  void operation.catch(failCheckout);

  try {
    await within(deadline, () => checkoutReady);
  } catch (error) {
    cancelled = true;
    startWork();
    throw error;
  }
  startWork();
  return operation;
}

/** A single released native read connection bounded by its caller's deadline. */
export function withManagementReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withManagementConnection(pool, deadline, ({ client }) => read(client));
}

/** A read-only snapshot that never queues rollback behind uncertain native I/O. */
export function withManagementReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withManagementConnection(pool, deadline, async ({ client, uncertain, discard }) => {
    let transactionStarted = false;
    let commitStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionStarted = true;
      const result = await read(client);
      requireAccessDeadline(deadline);
      commitStarted = true;
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (commitStarted || uncertain()) {
        discard(error);
      } else if (transactionStarted) {
        try {
          requireAccessDeadline(deadline);
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discard(rollbackError);
        }
      }
      throw error;
    }
  });
}
