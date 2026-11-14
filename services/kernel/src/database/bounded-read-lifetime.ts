import type { PoolClient, QueryConfig } from 'pg';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

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
}>;

type Checkout = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Discard = (client: PoolClient, error: Error) => void;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Bounded database read connection became uncertain');
}

function isPostgresServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
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
  const settledServerErrors = new WeakSet<object>();
  let transaction: 'none' | 'beginning' | 'open' | 'committing' | 'rolling-back' | 'committed' | 'rolled-back' = 'none';
  let hasFailure = false;
  let firstFailure: unknown;

  const remember = (error: unknown) => {
    if (!hasFailure) {
      hasFailure = true;
      firstFailure = error;
    }
  };
  const discard = (error: unknown) => {
    if (uncertain) return;
    uncertain = true;
    uncertainty = error;
    if (connection) discardConnection(connection, asError(error));
  };
  const isUncertain = (error: unknown) => {
    if (typeof error === 'object' && error !== null && settledServerErrors.has(error)) return false;
    return options.isUncertainError?.(error) ?? false;
  };
  const retiredError = () => new RetiredReadClientError();

  const operation = checkout(async (raw) => {
    connection = raw;
    if (retired) throw deadlineError();
    before(deadline, deadlineError);

    const client = Object.create(raw) as PoolClient;
    client.query = ((input: QueryConfig | string, values?: unknown[]) => {
      try {
        if (retired) throw retiredError();
        if (uncertain) throw uncertainty;
        before(deadline, deadlineError);
      } catch (error) {
        return Promise.reject(error);
      }

      const config: QueryConfig =
        typeof input === 'string' ? { text: input, ...(values === undefined ? {} : { values }) } : { ...input };
      let timeout: number;
      try {
        timeout = before(deadline, deadlineError);
      } catch (error) {
        return Promise.reject(error);
      }
      if (config.query_timeout === undefined) config.query_timeout = timeout;
      else if (typeof config.query_timeout === 'number' && config.query_timeout > 0)
        config.query_timeout = Math.min(config.query_timeout, timeout);

      const command = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(config.text ?? '')?.[1]?.toUpperCase();
      let dispatched = false;
      let settled = false;
      const native = Promise.resolve().then(() => {
        if (retired) throw retiredError();
        if (uncertain) throw uncertainty;
        before(deadline, deadlineError);
        dispatched = true;
        activeQueries += 1;
        return Reflect.apply(raw.query, raw, [config]) as Promise<unknown>;
      });
      const observed = native.then(
        (result) => {
          settled = true;
          if (dispatched) activeQueries -= 1;
          return result;
        },
        (error: unknown) => {
          settled = true;
          if (dispatched) activeQueries -= 1;
          throw error;
        },
      );

      return until(observed, deadline, deadlineError).catch((error: unknown) => {
        const mapped = mapError(error, options);
        const settledServerError = settled && isPostgresServerError(error);
        if (settledServerError) {
          if (typeof error === 'object' && error !== null) settledServerErrors.add(error);
          if (typeof mapped === 'object' && mapped !== null) settledServerErrors.add(mapped);
        }
        const uncertainSettledError =
          !settledServerError && (isUncertain(error) || options.isUncertainSettledQueryError?.(error) === true);
        if (dispatched && (!settled || command !== undefined || uncertainSettledError || Date.now() >= deadline))
          discard(mapped);
        throw mapped;
      });
    }) as PoolClient['query'];

    const run = async (): Promise<T> => {
      try {
        if (options.transaction === 'repeatable-read-read-only') {
          transaction = 'beginning';
          await client.query(begin);
          transaction = 'open';
        }

        const result = await read(client);
        if (uncertain) throw uncertainty;
        if (activeQueries > 0) {
          const error = new Error('A bounded database read returned with a native query still running');
          discard(error);
          throw error;
        }

        if (transaction === 'open') {
          transaction = 'committing';
          await client.query('COMMIT');
          transaction = 'committed';
        }
        return result;
      } catch (error) {
        const mapped = mapError(error, options);
        remember(mapped);
        if (options.isUncertainWorkError?.(error) || options.isUncertainWorkError?.(mapped)) discard(mapped);

        if (transaction === 'open') {
          if (uncertain || activeQueries > 0 || Date.now() >= deadline) {
            discard(firstFailure);
          } else {
            transaction = 'rolling-back';
            try {
              await client.query('ROLLBACK');
              transaction = 'rolled-back';
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
      if (
        activeQueries > 0 ||
        transaction === 'beginning' ||
        transaction === 'open' ||
        transaction === 'committing' ||
        transaction === 'rolling-back'
      )
        discard(firstFailure);
      throw firstFailure;
    } finally {
      retired = true;
    }
  });

  return until(operation, deadline, deadlineError).catch((error: unknown) => {
    retired = true;
    if (
      connection &&
      (activeQueries > 0 ||
        transaction === 'beginning' ||
        transaction === 'open' ||
        transaction === 'committing' ||
        transaction === 'rolling-back')
    )
      discard(hasFailure ? firstFailure : error);
    if (hasFailure) throw firstFailure;
    throw mapError(error, options);
  });
}
