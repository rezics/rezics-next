import type { Pool, PoolClient, QueryConfig } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { remaining, within } from '../access/deadline.ts';
import { discardConnection, withConnection } from '../database/pool.ts';

type ReadContext = Readonly<{
  discard(error: unknown): void;
  uncertain(): boolean;
  needsDiscardAfterDeadline(): boolean;
  remember(error: unknown): void;
}>;

type ConnectionState = {
  activeQueries: number;
  transactionOpen: boolean;
  uncertain: boolean;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Collection discovery connection became uncertain');
}

function deadlineClient(
  connection: PoolClient,
  deadline: number,
  state: ConnectionState,
  discard: (error: unknown) => void,
): PoolClient {
  const originalQuery = connection.query;
  const client = Object.create(connection) as PoolClient;
  client.query = (async (input: QueryConfig | string, values?: unknown[]) => {
    const config: QueryConfig = typeof input === 'string' ? { text: input, values: values ?? [] } : { ...input };
    const command = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(config.text ?? '')?.[1]?.toUpperCase();
    let settled = false;
    let dispatched = false;
    const operation = Promise.resolve().then(() => {
      config.query_timeout = remaining(deadline);
      dispatched = true;
      state.activeQueries += 1;
      return Reflect.apply(originalQuery, connection, [config]);
    });
    const observed = operation.then(
      (result) => {
        settled = true;
        if (dispatched) state.activeQueries -= 1;
        if (command === 'BEGIN') state.transactionOpen = true;
        if (command === 'COMMIT' || command === 'ROLLBACK') state.transactionOpen = false;
        return result;
      },
      (error) => {
        settled = true;
        if (dispatched) state.activeQueries -= 1;
        if (dispatched && (command !== undefined || classifyUnavailability(error) !== undefined))
          state.uncertain = true;
        throw error;
      },
    );
    try {
      return await within(deadline, () => observed);
    } catch (error) {
      if (dispatched && (!settled || command !== undefined || classifyUnavailability(error) !== undefined)) {
        state.uncertain = true;
        discard(error);
      }
      throw error;
    }
  }) as PoolClient['query'];
  return client;
}

async function withBoundedConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient, context: ReadContext) => Promise<T>,
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
        remaining(deadline);
        let uncertain = false;
        const state: ConnectionState = { activeQueries: 0, transactionOpen: false, uncertain: false };
        const discard = (error: unknown) => {
          uncertain = true;
          discardConnection(connection, asError(error));
        };
        const client = deadlineClient(connection, deadline, state, discard);
        const context = {
          discard,
          uncertain: () => uncertain || state.uncertain || state.activeQueries > 0,
          needsDiscardAfterDeadline: () =>
            uncertain || state.uncertain || state.activeQueries > 0 || state.transactionOpen,
          remember,
        };
        let started = false;
        try {
          return await within(deadline, () => {
            started = true;
            return work(client, context);
          });
        } catch (error) {
          if (started && Date.now() >= deadline && context.needsDiscardAfterDeadline()) discard(error);
          remember(error);
          throw error;
        }
      }),
    );
  } catch (error) {
    if (failed) throw failure;
    throw error;
  }
}

/** One repeatable-read snapshot with the request deadline on checkout, SQL and cleanup. */
export function withCollectionDiscoveryReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedConnection(pool, deadline, async (client, context) => {
    let began = false;
    try {
      // The deadline client treats an unresolved BEGIN as an uncertain transaction outcome.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      began = true;

      const value = await work(client);
      try {
        await client.query('COMMIT');
        began = false;
      } catch (error) {
        // COMMIT has an uncertain outcome; never queue rollback behind it.
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
          } catch (cleanupError) {
            context.discard(cleanupError);
          }
        }
      }
      throw error;
    }
  });
}
