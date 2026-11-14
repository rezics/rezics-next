import type { Pool, PoolClient } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, remaining, within } from './deadline.ts';
import { classifyUnavailability, requireAccessDeadline } from './unavailable.ts';

type TransactionControl = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' | 'COMMIT' | 'ROLLBACK';

function discardError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Managed erasure status read failed');
}

function uncertain(error: unknown, deadline: number): boolean {
  const reason = classifyUnavailability(error);
  return Date.now() >= deadline || reason === 'deadline' || reason === 'overloaded';
}

/** One checkout owned by the original managed erasure read deadline. */
export async function withErasureStatusReadConnection<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient, connection: PoolClient) => Promise<T>,
): Promise<T> {
  remaining(deadline);
  let checkedOut = false;
  let active: PoolClient | undefined;
  let resolveCheckout!: () => void;
  let rejectCheckout!: (error: unknown) => void;
  const checkout = new Promise<void>((resolve, reject) => {
    resolveCheckout = resolve;
    rejectCheckout = reject;
  });
  void checkout.catch(() => undefined);

  const operation = withConnection(pool, async (connection) => {
    requireAccessDeadline(deadline);
    checkedOut = true;
    active = connection;
    resolveCheckout();
    try {
      return await within(deadline, () => read(deadlineClient(connection, deadline), connection));
    } catch (error) {
      if (uncertain(error, deadline)) discardConnection(connection, discardError(error));
      throw error;
    } finally {
      active = undefined;
    }
  });
  void operation.catch((error) => {
    if (!checkedOut) rejectCheckout(error);
  });

  try {
    await within(deadline, () => checkout);
    return await operation;
  } catch (error) {
    if (active && uncertain(error, deadline)) discardConnection(active, discardError(error));
    if (checkedOut) {
      try {
        // The read callback is itself deadline wrapped, so this waits only for
        // its bounded unwind and ensures the discarded checkout is released.
        await operation;
      } catch {
        // Preserve the error observed by this visit, including its deadline.
      }
    }
    throw error;
  }
}

/** Read-only snapshot with bounded BEGIN, COMMIT, and rollback cleanup. */
export function withErasureStatusReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withErasureStatusReadConnection(pool, deadline, async (client, connection) => {
    let phase: 'begin' | 'read' | 'commit' = 'begin';

    const control = async (statement: TransactionControl, limit = deadline) => {
      let dispatched = false;
      try {
        await within(limit, async () => {
          requireAccessDeadline(limit);
          const pending = client.query(statement);
          dispatched = true;
          await pending;
        });
      } catch (error) {
        if (dispatched || uncertain(error, deadline)) discardConnection(connection, discardError(error));
        throw error;
      }
    };

    try {
      await control('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      phase = 'read';
      const result = await within(deadline, () => read(client));
      requireAccessDeadline(deadline);
      phase = 'commit';
      await control('COMMIT');
      return result;
    } catch (error) {
      if (phase === 'read') {
        if (uncertain(error, deadline)) {
          discardConnection(connection, discardError(error));
        } else {
          const cleanupDeadline = deadline - 1;
          if (cleanupDeadline <= Date.now()) {
            discardConnection(connection, discardError(error));
          } else {
            try {
              await control('ROLLBACK', cleanupDeadline);
            } catch {
              // Rollback failure cannot replace the source error.
            }
          }
        }
      }
      throw error;
    }
  });
}
