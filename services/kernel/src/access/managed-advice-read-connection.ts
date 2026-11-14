import type { Pool, PoolClient } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, remaining, within } from './deadline.ts';
import { classifyUnavailability, requireAccessDeadline } from './unavailable.ts';

type ManagedRead<T> = (connection: PoolClient, client: AccessClient, discard: (error: unknown) => void) => Promise<T>;

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error('Managed advice read failed');
}

/** Bound checkout separately so late clients are released without starting source SQL. */
async function withManagedConnection<T>(pool: Pool, deadline: number, read: ManagedRead<T>): Promise<T> {
  remaining(deadline);
  let checkedOut = false;
  let resolveCheckout!: () => void;
  let rejectCheckout!: (error: unknown) => void;
  const checkout = new Promise<void>((resolve, reject) => {
    resolveCheckout = resolve;
    rejectCheckout = reject;
  });
  void checkout.catch(() => undefined);

  const operation = withConnection(pool, async (connection) => {
    try {
      requireAccessDeadline(deadline);
    } catch (error) {
      checkedOut = true;
      rejectCheckout(error);
      throw error;
    }
    checkedOut = true;
    resolveCheckout();
    const client = deadlineClient(connection, deadline);
    return read(connection, client, (error) => discardConnection(connection, errorValue(error)));
  });
  void operation.catch((error) => {
    if (!checkedOut) rejectCheckout(error);
  });

  await within(deadline, () => checkout);
  return operation;
}

/** A deadline-bound non-transactional observation, such as authoritative read time. */
export function withManagedAdviceReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withManagedConnection(pool, deadline, async (connection, client, discard) => {
    try {
      return await within(deadline, () => read(client));
    } catch (error) {
      if (Date.now() >= deadline || classifyUnavailability(error) === 'deadline') discard(error);
      throw error;
    }
  });
}

/** One read snapshot whose uncertain or expired client is released immediately. */
export function withManagedAdviceReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withManagedConnection(pool, deadline, async (_connection, client, discard) => {
    let phase: 'begin' | 'read' | 'commit' = 'begin';
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      phase = 'read';
      const value = await within(deadline, () => read(client));
      requireAccessDeadline(deadline);
      phase = 'commit';
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (phase !== 'read' || Date.now() >= deadline || classifyUnavailability(error) === 'deadline') {
        discard(error);
        throw error;
      }

      const cleanupDeadline = deadline - 1;
      if (cleanupDeadline <= Date.now()) {
        discard(error);
        throw error;
      }
      try {
        await within(cleanupDeadline, () => client.query('ROLLBACK'));
      } catch (cleanupError) {
        discard(cleanupError);
      }
      throw error;
    }
  });
}
