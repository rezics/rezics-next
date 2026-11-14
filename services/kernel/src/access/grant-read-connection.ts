import type { Pool, PoolClient, QueryConfig } from 'pg';
import { remaining, within } from './deadline.ts';
import { AccessUnavailableError, classifyUnavailability } from './unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { AccessClient } from '../request/access.ts';

type GrantReadConnection = Readonly<{
  client: AccessClient;
  uncertain: () => boolean;
  uncertainty: () => Error | undefined;
  discard: (error: unknown) => void;
}>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Grant read connection became uncertain');
}

function grantReadConnection(connection: PoolClient, deadline: number): GrantReadConnection {
  let uncertainty: Error | undefined;
  const discard = (error: unknown) => {
    if (uncertainty) return;
    uncertainty = asError(error);
    discardConnection(connection, uncertainty);
  };
  const client = Object.create(connection) as AccessClient;
  client.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: remaining(deadline),
    };
    const native = Promise.resolve().then(() =>
      Reflect.apply(connection.query, connection, [config]) as Promise<unknown>,
    );
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
      if (!settled || Date.now() >= deadline || classifyUnavailability(error) !== undefined) discard(error);
      throw error;
    });
  }) as AccessClient['query'];
  return { client, uncertain: () => uncertainty !== undefined, uncertainty: () => uncertainty, discard };
}

async function withGrantReadCheckout<T>(
  pool: Pool,
  deadline: number,
  work: (connection: GrantReadConnection) => Promise<T>,
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
    const connection = grantReadConnection(native, deadline);
    // A checkout that arrives after expiry is released without dispatching SQL.
    remaining(deadline);
    if (cancelled) throw new AccessUnavailableError('deadline');
    announceCheckout();
    await workMayStart;
    if (cancelled) throw new AccessUnavailableError('deadline');
    remaining(deadline);
    return work(connection);
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

/** One released grant-read checkout bounded by the request's original deadline. */
export function withGrantReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withGrantReadCheckout(pool, deadline, ({ client }) => read(client));
}

/** One read-only repeatable-read snapshot with bounded BEGIN, work, COMMIT and cleanup. */
export function withGrantReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withGrantReadCheckout(pool, deadline, async ({ client, uncertain, uncertainty, discard }) => {
    let transactionMayBeOpen = false;
    let commitStarted = false;
    try {
      transactionMayBeOpen = true;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      } catch (error) {
        // A failed acknowledgement cannot prove that PostgreSQL did not begin.
        discard(error);
        throw error;
      }

      const result = await read(client);
      if (uncertainty()) throw uncertainty()!;
      commitStarted = true;
      try {
        await client.query('COMMIT');
      } catch (error) {
        // Never queue rollback behind a COMMIT whose result is unknown.
        discard(error);
        throw error;
      }
      transactionMayBeOpen = false;
      remaining(deadline);
      return result;
    } catch (error) {
      if (commitStarted || uncertain()) {
        discard(error);
      } else if (transactionMayBeOpen) {
        if (Date.now() >= deadline) {
          discard(error);
        } else {
          try {
            await client.query('ROLLBACK');
          } catch (cleanupError) {
            discard(cleanupError);
          }
        }
      }
      throw error;
    }
  });
}
