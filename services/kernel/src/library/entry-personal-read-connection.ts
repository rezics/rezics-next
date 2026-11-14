import type { Pool, PoolClient, QueryConfig } from 'pg';
import { remaining, within } from '../access/deadline.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';

type ReadContext = {
  discard(error: unknown): void;
  uncertain(): boolean;
  remember(error: unknown): void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Private entry read connection became uncertain');
}

function controlOf(sql: string): 'begin' | 'commit' | 'rollback' | 'other' {
  const command = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toLowerCase();
  if (command === 'begin' || command === 'commit' || command === 'rollback') return command;
  return 'other';
}

function deadlineClient(connection: PoolClient, deadline: number, markUncertain: (error: unknown) => void): PoolClient {
  const client = Object.create(connection) as PoolClient;
  client.query = ((query: QueryConfig | string, values?: unknown[]) => {
    const config = {
      ...(typeof query === 'string' ? { text: query, values: values ?? [] } : query),
      query_timeout: remaining(deadline),
    } as QueryConfig;
    const control = controlOf(config.text ?? '');
    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(Reflect.apply(connection.query, connection, [config]));
    } catch (error) {
      if (
        control === 'begin' ||
        control === 'commit' ||
        control === 'rollback' ||
        classifyUnavailability(error) !== undefined
      )
        markUncertain(error);
      throw error;
    }

    let settled = false;
    const observed = operation.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    return within(deadline, () => observed).catch((error) => {
      if (
        !settled ||
        Date.now() >= deadline ||
        control === 'commit' ||
        control === 'rollback' ||
        (control === 'begin' && classifyUnavailability(error) === undefined) ||
        classifyUnavailability(error) !== undefined
      )
        markUncertain(error);
      throw error;
    });
  }) as PoolClient['query'];
  return client;
}

async function withReadConnection<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient, context: ReadContext) => Promise<T>,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  const remember = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };

  try {
    return await within(deadline, () =>
      withConnection(pool, async (connection) => {
        let uncertain = false;
        const discard = (error: unknown) => {
          uncertain = true;
          discardConnection(connection, asError(error));
        };
        const client = deadlineClient(connection, deadline, discard);
        const context = { discard, uncertain: () => uncertain, remember };
        let started = false;
        try {
          remaining(deadline);
          return await within(deadline, () => {
            remaining(deadline);
            started = true;
            return work(client, context);
          });
        } catch (error) {
          if (started && Date.now() >= deadline) discard(error);
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

/** Runs private entry reads in one deadline-bounded repeatable-read snapshot. */
export function withEntryPersonalReadSnapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withReadConnection(pool, deadline, async (client, context) => {
    let began = false;
    let commitStarted = false;
    try {
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        began = true;
      } catch (error) {
        context.remember(error);
        if (context.uncertain()) context.discard(error);
        throw error;
      }

      const result = await read(client);
      commitStarted = true;
      try {
        await client.query('COMMIT');
        began = false;
      } catch (error) {
        context.discard(error);
        throw error;
      }
      return result;
    } catch (error) {
      context.remember(error);
      if (commitStarted) {
        context.discard(error);
      } else if (began) {
        if (context.uncertain() || Date.now() >= deadline) {
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
