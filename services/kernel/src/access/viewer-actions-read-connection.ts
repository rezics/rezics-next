import type { Pool, PoolClient, QueryConfig } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { classifyUnavailability, AccessUnavailableError } from './unavailable.ts';
import { remaining, within } from './deadline.ts';

type ReadCheckout = Readonly<{
  client: AccessClient;
  uncertain(): boolean;
  uncertainty(): Error | undefined;
  discard(error: unknown): void;
}>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Viewer actions read connection became uncertain');
}

function viewerActionsClient(connection: PoolClient, deadline: number): ReadCheckout {
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
    const native = Promise.resolve().then(
      () => Reflect.apply(connection.query, connection, [config]) as Promise<unknown>,
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

async function withViewerActionsCheckout<T>(
  pool: Pool,
  deadline: number,
  work: (checkout: ReadCheckout) => Promise<T>,
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
  const operation = withConnection(pool, async (connection) => {
    remaining(deadline);
    if (cancelled) throw new AccessUnavailableError('deadline');
    const checkout = viewerActionsClient(connection, deadline);
    announceCheckout();
    await workMayStart;
    if (cancelled) throw new AccessUnavailableError('deadline');
    remaining(deadline);
    return work(checkout);
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

/** One read-only repeatable-read snapshot bounded by the request's original deadline. */
export function withViewerActionsReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withViewerActionsCheckout(pool, deadline, async ({ client, uncertain, uncertainty, discard }) => {
    let phase: 'begin' | 'read' | 'commit' = 'begin';
    try {
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      } catch (error) {
        // PostgreSQL may have opened the snapshot even when BEGIN's acknowledgement was lost.
        discard(error);
        throw error;
      }

      phase = 'read';
      const value = await read(client);
      if (uncertain()) throw uncertainty()!;

      phase = 'commit';
      try {
        await client.query('COMMIT');
      } catch (error) {
        // Never queue rollback behind a COMMIT whose result is unknown.
        discard(error);
        throw error;
      }
      remaining(deadline);
      return value;
    } catch (error) {
      if (phase !== 'read' || uncertain() || Date.now() >= deadline) {
        discard(error);
        throw error;
      }
      try {
        await client.query('ROLLBACK');
      } catch (cleanupError) {
        discard(cleanupError);
      }
      throw error;
    }
  });
}
