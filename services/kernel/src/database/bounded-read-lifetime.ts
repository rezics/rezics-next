import type { PoolClient, QueryArrayConfig, QueryConfig } from 'pg';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

/** QueryConfig extensions for pg's runtime timeout and array-result options. */
export type NativeReadQueryConfig<I = unknown[]> = QueryConfig<I> & {
  query_timeout?: number;
  rowMode?: 'array';
};

export type NativeReadQueryArrayConfig<I = unknown[]> = QueryArrayConfig<I> & {
  query_timeout?: number;
};

export class BoundedReadDeadlineError extends Error {
  constructor() {
    super('The bounded database read deadline expired');
    this.name = 'BoundedReadDeadlineError';
  }
}

export class RetiredReadClientError extends Error {
  constructor() {
    super('The bounded database read client is no longer active');
    this.name = 'RetiredReadClientError';
  }
}

export type BoundedReadLifetimeOptions = Readonly<{
  transaction?: 'repeatable-read-read-only';
  deadlineError?: () => Error;
  mapError?: (error: unknown) => unknown;
  isUncertainError?: (error: unknown) => boolean;
  isUncertainSettledQueryError?: (error: unknown) => boolean;
  isUncertainWorkError?: (error: unknown) => boolean;
  onRetire?: () => void;
}>;

type Checkout = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Discard = (client: PoolClient, error: Error) => void;
const deferredReadDiscards = new WeakMap<PoolClient, (error: Error) => void>();

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Bounded database read connection became uncertain');
}

function isPostgresServerError(error: unknown): error is { code: string; severity: 'ERROR' } {
  if (typeof error !== 'object' || error === null) return false;
  return (
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code) &&
    'severity' in error &&
    error.severity === 'ERROR'
  );
}

/** Native serialization and deadlock errors confirm rollback, including at COMMIT. */
export function isPostgresTransactionAbort(error: unknown): boolean {
  return isPostgresServerError(error) && (error.code === '40001' || error.code === '40P01');
}

/** Savepoint rollback and transaction chaining retain the current checkout's custody. */
function transactionStateAfter(sql = ''): 'none' | 'open' | undefined {
  let offset = 0;
  const word = (): string | undefined => {
    while (offset < sql.length) {
      const space = /^(?:\s+|--[^\r\n]*)/.exec(sql.slice(offset));
      if (space) {
        offset += space[0].length;
        continue;
      }
      if (!sql.startsWith('/*', offset)) break;
      offset += 2;
      let depth = 1;
      while (depth > 0 && offset < sql.length) {
        if (sql.startsWith('/*', offset)) {
          depth += 1;
          offset += 2;
        } else if (sql.startsWith('*/', offset)) {
          depth -= 1;
          offset += 2;
        } else offset += 1;
      }
    }
    const token = /^[a-z]+/i.exec(sql.slice(offset))?.[0];
    if (token === undefined) return undefined;
    offset += token.length;
    return token.toUpperCase();
  };

  const command = word();
  if (command === 'BEGIN' || command === 'SAVEPOINT' || command === 'RELEASE') return 'open';
  if (command === 'START') return word() === 'TRANSACTION' ? 'open' : undefined;
  if (command !== 'COMMIT' && command !== 'END' && command !== 'ROLLBACK' && command !== 'ABORT') return undefined;
  let next = word();
  if (next === 'PREPARED') return undefined;
  if (next === 'WORK' || next === 'TRANSACTION') next = word();
  if (command === 'ROLLBACK' && next === 'TO') return 'open';
  return next === 'AND' && word() === 'CHAIN' ? 'open' : 'none';
}

function mapError(error: unknown, options: BoundedReadLifetimeOptions): unknown {
  if (!options.mapError) return error;
  try {
    return options.mapError(error);
  } catch (mapped) {
    return mapped;
  }
}

function before(deadline: number, deadlineError: () => Error): number {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw deadlineError();
  return Math.max(1, Math.floor(deadline - Date.now()));
}

function until<T>(value: Promise<T>, deadline: number, deadlineError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  return new Promise<T>((resolve, reject) => {
    const expire = () => {
      if (finished) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.max(1, Math.ceil(remaining)));
        return;
      }
      finished = true;
      reject(deadlineError());
    };
    timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - Date.now())));
    Promise.resolve(value).then(
      (result) => {
        if (finished) return;
        finished = true;
        if (Date.now() >= deadline) reject(deadlineError());
        else resolve(result);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        reject(error);
      },
    );
  }).finally(() => clearTimeout(timer));
}

/** Apply one deadline to checkout, native queries, callback work and transaction cleanup. */
export function withBoundedReadLifetime<T>(
  checkout: Checkout,
  discardConnection: Discard,
  deadline: number,
  read: (client: PoolClient) => Promise<T>,
  options: BoundedReadLifetimeOptions = {},
): Promise<T> {
  const deadlineError = options.deadlineError ?? (() => new BoundedReadDeadlineError());
  try {
    before(deadline, deadlineError);
  } catch (error) {
    return Promise.reject(error);
  }
  let connection: PoolClient | undefined;
  let retired = false;
  let uncertain = false;
  let uncertainty: unknown;
  let activeQueries = 0;
  let pendingQueries = 0;
  const settledServerErrors = new Set<unknown>();
  // Native custody is independent of whether this helper owns automatic completion.
  let transaction: 'none' | 'open' = 'none';
  let hasFailure = false;
  let firstFailure: unknown;
  let deferredDiscard: Error | undefined;

  const retire = () => {
    if (retired) return;
    retired = true;
    options.onRetire?.();
  };

  const remember = (error: unknown) => {
    if (!hasFailure) {
      hasFailure = true;
      firstFailure = error;
    }
  };
  const markForDiscard = (error: Error) => {
    if (!connection) return;
    const parentDiscard = deferredReadDiscards.get(connection);
    if (parentDiscard) parentDiscard(error);
    else discardConnection(connection, error);
  };
  const deferDiscard = (error: Error) => {
    if (!retired) deferredDiscard ??= error;
  };
  const discard = (error: unknown) => {
    if (uncertain) return;
    uncertain = true;
    uncertainty = error;
    retire();
    markForDiscard(asError(error));
  };
  const retiredError = () => new RetiredReadClientError();

  const operation = checkout(async (raw) => {
    connection = raw;
    if (retired) throw deadlineError();
    before(deadline, deadlineError);

    const client = Object.create(raw) as PoolClient;
    // The lease can request disposal, but the checkout owner releases after cleanup.
    client.release = (error) => {
      if (error) deferDiscard(asError(error));
    };
    deferredReadDiscards.set(client, deferDiscard);
    client.query = ((input: NativeReadQueryConfig | string, valuesOrCallback?: unknown, callbackArgument?: unknown) => {
      const callback = typeof valuesOrCallback === 'function' ? valuesOrCallback : callbackArgument;
      const completeWithCallback = (completion: Promise<unknown>) => {
        if (typeof callback !== 'function') return completion;
        void completion.then(
          (result) => Reflect.apply(callback, undefined, [null, result]),
          (error: unknown) => Reflect.apply(callback, undefined, [error]),
        );
        return undefined;
      };
      try {
        if (retired) throw retiredError();
        if (uncertain) throw uncertainty;
        before(deadline, deadlineError);
      } catch (error) {
        return completeWithCallback(Promise.reject(error));
      }

      const queryValues = Array.isArray(valuesOrCallback) ? valuesOrCallback : undefined;
      const config: NativeReadQueryConfig =
        typeof input === 'string'
          ? { text: input, ...(queryValues === undefined ? {} : { values: queryValues }) }
          : { ...input, ...(queryValues === undefined ? {} : { values: queryValues }) };
      let timeout: number;
      try {
        timeout = before(deadline, deadlineError);
      } catch (error) {
        return completeWithCallback(Promise.reject(error));
      }
      config.query_timeout =
        typeof config.query_timeout === 'number' && config.query_timeout > 0
          ? Math.min(config.query_timeout, timeout)
          : timeout;

      const transactionAfter = transactionStateAfter(config.text);
      if (transactionAfter === 'none' && pendingQueries > 0)
        return completeWithCallback(Promise.reject(new Error('A terminal transaction query cannot follow unsettled SQL')));
      pendingQueries += 1;
      let dispatched = false;
      let settled = false;
      let nativeFailed = false;
      const native = Promise.resolve().then(() => {
        if (retired) throw retiredError();
        if (uncertain) throw uncertainty;
        before(deadline, deadlineError);
        dispatched = true;
        activeQueries += 1;
        return Reflect.apply(raw.query, raw, [config]);
      });
      const observed = native.then(
        (result) => {
          // Observe native completion even if the deadline already retired the wrapper.
          // A late terminal response must never undo an earlier discard.
          if (dispatched && transactionAfter !== undefined) transaction = transactionAfter;
          settled = true;
          pendingQueries -= 1;
          if (dispatched) activeQueries -= 1;
          return result;
        },
        (error: unknown) => {
          // A native rejection alone does not prove that the server finished the query.
          settled = isPostgresServerError(error);
          nativeFailed = true;
          if (!dispatched || settled) pendingQueries -= 1;
          if (dispatched && settled) activeQueries -= 1;
          throw error;
        },
      );

      const completion = until(observed, deadline, deadlineError).catch((error: unknown) => {
        const settledServerError = nativeFailed && isPostgresServerError(error);
        const mapped = mapError(error, options);
        if (settledServerError) {
          settledServerErrors.add(error);
          settledServerErrors.add(mapped);
        }
        if (dispatched && !settled) {
          // Catching an uncertain native failure cannot erase the lifetime's first cause.
          remember(mapped);
          discard(mapped);
        }
        throw mapped;
      });
      // Observe failure even when the read callback leaves this query unawaited.
      void completion.catch(() => {});
      return completeWithCallback(completion);
    }) as PoolClient['query'];

    const run = async (): Promise<T> => {
      try {
        if (options.transaction === 'repeatable-read-read-only') {
          await client.query(begin);
        }

        const result = await read(client);
        if (uncertain) throw uncertainty;
        if (activeQueries > 0) {
          const error = new Error('A bounded database read returned with a native query still running');
          discard(error);
          throw error;
        }

        if (transaction === 'open') {
          if (options.transaction !== 'repeatable-read-read-only')
            throw new Error('A bounded database read returned with a manual transaction still open');
          await client.query('COMMIT');
        }
        return result;
      } catch (error) {
        const mapped = mapError(error, options);
        remember(mapped);
        if (
          (!settledServerErrors.has(error) || options.isUncertainSettledQueryError?.(error) ||
            options.isUncertainSettledQueryError?.(mapped)) &&
          (options.isUncertainWorkError?.(error) || options.isUncertainWorkError?.(mapped))
        )
          discard(mapped);

        if (transaction === 'open') {
          if (uncertain || activeQueries > 0 || Date.now() >= deadline) {
            discard(firstFailure);
          } else {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackError) {
              discard(rollbackError);
            }
          }
        }
        throw firstFailure;
      }
    };

    try {
      return await until(run(), deadline, deadlineError);
    } catch (error) {
      const mapped = mapError(error, options);
      remember(mapped);
      if (Date.now() >= deadline || activeQueries > 0 || transaction === 'open') discard(firstFailure);
      throw firstFailure;
    } finally {
      retire();
      if (deferredDiscard && !uncertain) markForDiscard(deferredDiscard);
    }
  });

  return until(operation, deadline, deadlineError).catch((error: unknown) => {
    retire();
    if (connection && (Date.now() >= deadline || activeQueries > 0 || transaction === 'open'))
      discard(hasFailure ? firstFailure : error);
    if (hasFailure) throw firstFailure;
    throw mapError(error, options);
  });
}
