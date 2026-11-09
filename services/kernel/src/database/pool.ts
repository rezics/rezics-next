import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type Pool, type PoolClient } from 'pg';
import { ConfigError } from '../commerce/config.ts';
export { partitionReadClient, partitionReadClientObservation, partitionReadClients } from './read-snapshot.ts';

export const KERNEL_POOL_MAX = 10;
const DEFAULT_ACQUIRE_TIMEOUT_MILLIS = 200;
const ACQUIRE_TIMEOUT_VARIABLE = 'KERNEL_POOL_ACQUIRE_TIMEOUT_MS';

export function readPoolAcquireTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[ACQUIRE_TIMEOUT_VARIABLE];
  if (value === undefined) return DEFAULT_ACQUIRE_TIMEOUT_MILLIS;
  if (!/^\d+$/.test(value)) throw new ConfigError(ACQUIRE_TIMEOUT_VARIABLE);
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 10_000) {
    throw new ConfigError(ACQUIRE_TIMEOUT_VARIABLE);
  }
  return timeout;
}

export class NestedPoolCheckoutError extends Error {
  constructor() {
    super('A command cannot check out a second connection from the same pool');
    this.name = 'NestedPoolCheckoutError';
  }
}

const heldPools = new AsyncLocalStorage<ReadonlySet<Pool>>();
export type PoolCheckoutObserver = Readonly<{ started(): void; completed(waitMs: number, acquired: boolean): void }>;
const poolCheckoutObservers = new AsyncLocalStorage<PoolCheckoutObserver>();
const brokenClients = new WeakMap<PoolClient, Error>();
type Connect = Pool['connect'];

/** Observe checkout timing for one caller without exposing pool/query contents. */
export function withPoolCheckoutObservation<T>(observer: PoolCheckoutObserver, run: () => Promise<T>): Promise<T> {
  return poolCheckoutObservers.run(observer, run);
}

/** Driver seam for focused timing proofs; production invokes the captured observer from Pool.connect. */
export function recordPoolCheckoutStart(): void {
  reportPoolCheckoutStart(poolCheckoutObservers.getStore());
}

/** Driver seam for focused timing proofs; production invokes the captured observer from Pool.connect. */
export function recordPoolCheckoutComplete(waitMs: number, acquired: boolean): void {
  reportPoolCheckoutComplete(poolCheckoutObservers.getStore(), waitMs, acquired);
}

function reportPoolCheckoutStart(observer: PoolCheckoutObserver | undefined): void {
  if (!observer) return;
  try {
    observer.started();
  } catch {
    // Diagnostics must not change pool checkout behaviour.
  }
}

function reportPoolCheckoutComplete(
  observer: PoolCheckoutObserver | undefined,
  waitMs: number,
  acquired: boolean,
): void {
  if (!observer) return;
  try {
    observer.completed(waitMs, acquired);
  } catch {
    // Diagnostics must not change pool checkout behaviour.
  }
}

export function createPool(
  url: string,
  options: { connectionTimeoutMillis?: number; idleTimeoutMillis?: number; min?: number } = {},
): Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: KERNEL_POOL_MAX,
    ...(options.min === undefined ? {} : { min: options.min }),
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? readPoolAcquireTimeoutMillis(),
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    options: '-c idle_in_transaction_session_timeout=5000',
    types: {
      getTypeParser(oid, format) {
        // pg omits name[] (1003); it uses the same wire representation as text[] (1009).
        const nameArray = oid === (1003 as typeof oid) && format !== 'binary';
        return pg.types.getTypeParser(nameArray ? (1009 as typeof oid) : oid, format);
      },
    },
  });
  pool.on('error', () => {});
  pool.on('connect', (client) => client.on('error', () => {}));

  const connect = pool.connect.bind(pool) as Connect;
  (pool as Pool & { connect: Connect }).connect = ((callback?: Parameters<Connect>[0]) => {
    const observer = poolCheckoutObservers.getStore();
    const started = observer ? performance.now() : 0;
    reportPoolCheckoutStart(observer);
    if (heldPools.getStore()?.has(pool)) {
      const error = new NestedPoolCheckoutError();
      if (callback) {
        queueMicrotask(() => {
          reportPoolCheckoutComplete(observer, 0, false);
          callback(error, undefined as never, undefined as never);
        });
        return undefined as never;
      }
      const rejected = Promise.reject(error);
      return (
        observer
          ? rejected.catch((reason: unknown) => {
              reportPoolCheckoutComplete(observer, 0, false);
              throw reason;
            })
          : rejected
      ) as never;
    }
    if (callback)
      return connect((error, client, release) => {
        reportPoolCheckoutComplete(observer, observer ? performance.now() - started : 0, !error && !!client);
        callback(error, client, release);
      });
    const pending = connect();
    return (
      observer
        ? pending.then(
            (client) => {
              reportPoolCheckoutComplete(observer, performance.now() - started, true);
              return client;
            },
            (error: unknown) => {
              reportPoolCheckoutComplete(observer, performance.now() - started, false);
              throw error;
            },
          )
        : pending
    ) as never;
  }) as Connect;
  const originalQuery = pool.query;
  pool.query = ((...args: unknown[]) => {
    const accounting = queryAccounting.getStore();
    const dispatch = () => Reflect.apply(originalQuery, pool, args);
    return accounting ? accountQuery(accounting, args, () => accounting.connection(dispatch)) : dispatch();
  }) as Pool['query'];
  return pool;
}

/** Accounting only: the executor retains its original client and cleanup custody. */
export type QueryAccounting = Readonly<{
  query<T>(sql: string, operands: readonly unknown[], dispatch: () => Promise<T>): Promise<T>;
  connection<T>(dispatch: () => Promise<T>): Promise<T>;
}>;
const queryAccounting = new AsyncLocalStorage<QueryAccounting>();
export function withQueryAccounting<T>(accounting: QueryAccounting, run: () => Promise<T>): Promise<T> {
  return queryAccounting.run(accounting, run);
}

function accountQuery<T>(accounting: QueryAccounting, args: unknown[], dispatch: () => Promise<T>): Promise<T> {
  const statement = args[0] as string | { text: string; values?: readonly unknown[] };
  const sql = typeof statement === 'string' ? statement : statement.text;
  const operands =
    typeof statement === 'string' ? ((args[1] as readonly unknown[] | undefined) ?? []) : (statement.values ?? []);
  return accounting.query(sql, operands, dispatch);
}

export function withConnection<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const accounting = queryAccounting.getStore();
  const dispatch = () => checkedOutConnection(pool, work, accounting);
  return accounting ? accounting.connection(dispatch) : dispatch();
}

async function checkedOutConnection<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  accounting: QueryAccounting | undefined,
): Promise<T> {
  const client = await pool.connect();
  const parent = heldPools.getStore();
  const next = new Set(parent);
  next.add(pool);
  const originalQuery = client.query;
  if (accounting) {
    client.query = ((...args: unknown[]) => {
      return accountQuery(accounting, args, () => Reflect.apply(originalQuery, client, args));
    }) as PoolClient['query'];
  }
  try {
    return await heldPools.run(next, () => work(client));
  } finally {
    client.query = originalQuery;
    client.release(brokenClients.get(client));
  }
}

export function discardConnection(client: PoolClient, error: Error): void {
  brokenClients.set(client, error);
}
