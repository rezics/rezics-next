import type { Pool, PoolClient, QueryConfig } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { remaining, within } from '../access/deadline.ts';
import { discardConnection, withConnection } from '../database/pool.ts';

type ReadWorkContext = {
  discard(error: unknown): void;
  uncertain(): boolean;
  remember(error: unknown): void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Continue read connection became uncertain');
}

function deadlineReadClient(
  connection: PoolClient,
  deadline: number,
  markUncertain: (error: unknown) => void,
): PoolClient {
  const client = Object.create(connection) as PoolClient;
  client.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: remaining(deadline),
    } as QueryConfig;
    const operation = Promise.resolve().then(() => connection.query(config));
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return within(deadline, () => operation).catch((error) => {
      if (!settled || Date.now() >= deadline || classifyUnavailability(error) !== undefined) markUncertain(error);
      throw error;
    });
  }) as PoolClient['query'];
  return client;
}

async function withBoundedConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient, context: ReadWorkContext) => Promise<T>,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  const remember = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  try {
    return await within(deadline, () =>
      withConnection(pool, async (connection) => {
        let uncertain = false;
        const discard = (error: unknown) => {
          uncertain = true;
          discardConnection(connection, asError(error));
        };
        const client = deadlineReadClient(connection, deadline, discard);
        const context = { discard, uncertain: () => uncertain, remember };
        let started = false;
        try {
          remaining(deadline);
          return await within(deadline, () => {
            started = true;
            return work(client, context);
          });
        } catch (error) {
          // An expired visit cannot return a connection whose native read may still be running.
          if (started && Date.now() >= deadline) discard(error);
          remember(error);
          throw error;
        }
      }),
    );
  } catch (error) {
    // Cleanup may use the rest of the deadline. Keep the original read failure visible.
    if (failed) throw failure;
    throw error;
  }
}

/** A deadline-bounded repeatable-read snapshot for Continue owner reads. */
export function withContinueReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedConnection(pool, deadline, async (client, context) => {
    let began = false;
    try {
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        began = true;
      } catch (error) {
        // BEGIN may have reached PostgreSQL even when its acknowledgement did not.
        context.discard(error);
        throw error;
      }

      const value = await work(client);
      try {
        await client.query('COMMIT');
        began = false;
      } catch (error) {
        // Never queue rollback behind an uncertain COMMIT.
        context.discard(error);
        throw error;
      }
      return value;
    } catch (error) {
      context.remember(error);
      if (began) {
        if (Date.now() >= deadline || context.uncertain()) {
          context.discard(error);
        } else {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            context.discard(rollbackError);
          }
        }
      }
      throw error;
    }
  });
}
