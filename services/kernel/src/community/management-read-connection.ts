import type { Pool, PoolClient, QueryConfig } from 'pg';
import { remaining, within } from '../access/deadline.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

type ManagementConnection = Readonly<{
  client: AccessClient;
  uncertain: () => boolean;
  discard: (error: unknown) => void;
}>;

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function managementConnection(connection: PoolClient, deadline: number): ManagementConnection {
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
      if (!settled || Date.now() >= deadline) discard(error);
      throw error;
    });
  }) as AccessClient['query'];
  return { client, uncertain: () => uncertainty !== undefined, discard };
}

async function withManagementConnection<T>(
  pool: Pool,
  deadline: number,
  work: (connection: ManagementConnection) => Promise<T>,
): Promise<T> {
  remaining(deadline);
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
    const managed = managementConnection(native, deadline);
    // A checkout that arrives after the request deadline is returned without
    // starting even the first SQL statement.
    remaining(deadline);
    if (cancelled) throw new AccessUnavailableError('deadline');
    announceCheckout();
    await workMayStart;
    if (cancelled) throw new AccessUnavailableError('deadline');
    remaining(deadline);
    return work(managed);
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

/** A released, deadline-bound checkout for one Community management read. */
export function withManagementReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withManagementConnection(pool, deadline, ({ client }) => read(client));
}

/** A bounded read-only snapshot that never queues cleanup behind unfinished I/O. */
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
      commitStarted = true;
      await client.query('COMMIT');
      transactionStarted = false;
      remaining(deadline);
      return result;
    } catch (error) {
      if (commitStarted || uncertain()) {
        discard(error);
      } else if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (cleanupError) {
          discard(cleanupError);
        }
      }
      throw error;
    }
  });
}
