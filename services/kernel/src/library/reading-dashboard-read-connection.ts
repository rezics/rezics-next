import type { Pool, PoolClient, QueryConfig } from 'pg';
import { within } from '../access/deadline.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';

type Work<T> = (client: PoolClient) => Promise<T>;
type Control = 'begin' | 'commit' | 'rollback' | 'savepoint-rollback' | 'other';

function expired(): ProblemError {
  return new ProblemError('deadline_exceeded');
}

function deadlineRace<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(expired());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(expired());
    const remove = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        remove();
        resolve(value);
      },
      (error) => {
        remove();
        reject(error);
      },
    );
  });
}

function controlOf(sql: string): Control {
  const command = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toUpperCase();
  if (command === 'BEGIN') return 'begin';
  if (command === 'COMMIT') return 'commit';
  if (command === 'ROLLBACK') return /^\s*ROLLBACK\s+TO\b/i.test(sql) ? 'savepoint-rollback' : 'rollback';
  return 'other';
}

function isPostgresError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : '';
  return (
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    code !== '57014' &&
    !/query read timeout/i.test(message)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Reading dashboard connection was discarded');
}

/** Keeps dashboard read SQL and cleanup inside the request's original connection lifetime. */
export function withReadingDashboardReadConnection<T>(
  pool: Pool,
  options: { deadline: number; signal?: AbortSignal },
  work: Work<T>,
): Promise<T> {
  const { deadline, signal } = options;
  if (signal?.aborted) return Promise.reject(expired());
  return within(deadline, () =>
    deadlineRace(
      Promise.resolve().then(() =>
        withConnection(pool, async (connection) => {
          let transactionOpen = false;
          let committed = false;
          let uncertain = false;
          let cleaningUp = false;
          const originalQuery = connection.query;
          const client = Object.create(connection) as PoolClient;

          client.query = (async (input: QueryConfig | string, values?: unknown[]) => {
            if (Date.now() >= deadline || (signal?.aborted && !cleaningUp)) throw expired();
            const timeout = Math.max(1, Math.floor(deadline - Date.now()));
            const config: QueryConfig =
              typeof input === 'string'
                ? { text: input, values: values ?? [], query_timeout: timeout }
                : { ...input, query_timeout: timeout };
            const sql = config.text;
            const control = controlOf(sql);
            let settled = false;
            let knownOutcome = false;
            let request: Promise<unknown>;
            try {
              request = Promise.resolve(Reflect.apply(originalQuery, connection, [config]));
            } catch (error) {
              if (control !== 'other' || !isPostgresError(error)) uncertain = true;
              throw error;
            }
            const observed = request.then(
              (result) => {
                settled = true;
                knownOutcome = true;
                if (control === 'begin') transactionOpen = true;
                if (control === 'commit') {
                  transactionOpen = false;
                  committed = true;
                }
                if (control === 'rollback') transactionOpen = false;
                return result;
              },
              (error) => {
                settled = true;
                knownOutcome = isPostgresError(error);
                throw error;
              },
            );
            try {
              return await within(deadline, () => deadlineRace(observed, cleaningUp ? undefined : signal));
            } catch (error) {
              if (
                !settled ||
                control === 'begin' ||
                control === 'commit' ||
                control === 'rollback' ||
                !knownOutcome
              )
                uncertain = true;
              throw error;
            }
          }) as PoolClient['query'];

          if (Date.now() >= deadline || signal?.aborted) throw expired();
          try {
            return await work(client);
          } catch (primary) {
            if (uncertain) {
              discardConnection(connection, asError(primary));
            } else if (transactionOpen && !committed) {
              cleaningUp = true;
              try {
                await client.query('ROLLBACK');
              } catch (cleanupError) {
                discardConnection(connection, asError(cleanupError));
              } finally {
                cleaningUp = false;
              }
            }
            throw primary;
          }
        }),
      ),
      signal,
    ),
  );
}
