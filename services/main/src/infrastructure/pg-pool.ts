import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';

/**
 * Session defaults for every request-serving PostgreSQL pool. Request paths
 * that need less set `SET LOCAL lock_timeout = '2s'` and a 5 s statement
 * timeout; these catch the paths that set nothing.
 *
 * - Lock waits sit above the 2 s request bound and below the 8 s the refresh
 *   token guard and 15 s the Content rebuild fence set for themselves.
 * - A transaction may idle while it awaits one Fuseki command (10 s deadline,
 *   12 s fetch) or catalogue batch (35 s fetch), or an Account provider
 *   exchange under its advisory lock; one minute covers the longest.
 * - No request-pool transaction legitimately runs for minutes: statement
 *   timeouts are at most 60 s. Restore, rebuild, migration and capture jobs
 *   open their own connections.
 */
export interface ConnectionBounds {
  lockTimeout: string;
  idleInTransactionSessionTimeout: string;
  transactionTimeout: string;
}

export const CONNECTION_BOUNDS: ConnectionBounds = {
  lockTimeout: '5s',
  idleInTransactionSessionTimeout: '60s',
  transactionTimeout: '5min',
};

/**
 * How long a request pool waits for a free connection. Matches lock_timeout:
 * above the 2 s request bound, under the 8 s refresh-token guard and the 15 s
 * Content rebuild fence. node-postgres uses 0 to mean wait forever, so a
 * missing or non-positive wait is this default.
 */
export const CONNECTION_CHECKOUT_WAIT_MS = 5_000;

/** The caller already holds a client from this pool and asked for another. */
export class NestedPoolCheckoutError extends Error {
  constructor() {
    super('Nested PostgreSQL pool checkout');
    this.name = 'NestedPoolCheckoutError';
  }
}

export type NestedPoolCheckoutMode = 'log' | 'throw';

const checkoutHolds = new AsyncLocalStorage<Set<Pool>>();
let checkoutMode: NestedPoolCheckoutMode =
  process.env.REZICS_NESTED_POOL_CHECKOUT === 'throw' ? 'throw' : 'log';

export function nestedPoolCheckoutMode(): NestedPoolCheckoutMode {
  return checkoutMode;
}

/** Tests switch this to `throw`. Production stays on `log` until callers that
 * hold a client across a second checkout of the same pool are fixed. Starting
 * the process with REZICS_NESTED_POOL_CHECKOUT=throw selects throw as well. */
export function setNestedPoolCheckoutMode(mode: NestedPoolCheckoutMode): void {
  checkoutMode = mode;
}

function checkoutWait(requested: number | undefined): number {
  if (requested === undefined || requested <= 0) return CONNECTION_CHECKOUT_WAIT_MS;
  return requested;
}

function adoptHold(pool: Pool): void {
  const existing = checkoutHolds.getStore();
  if (existing) {
    existing.add(pool);
    return;
  }
  // enterWith during the synchronous connect() sticks across the caller's
  // await. Wrapping the resolved promise does not, on this runtime.
  checkoutHolds.enterWith(new Set([pool]));
}

function releaseHold(pool: Pool): void {
  checkoutHolds.getStore()?.delete(pool);
}

type ConnectCallback = (
  err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void,
) => void;

function trackNestedCheckout(pool: Pool): void {
  const original = pool.connect.bind(pool) as Pool['connect'];
  const connect = (callback?: ConnectCallback) => {
    const nested = checkoutHolds.getStore()?.has(pool) ?? false;
    if (nested) {
      const error = new NestedPoolCheckoutError();
      if (checkoutMode === 'throw') {
        if (typeof callback === 'function') {
          // pool.query has already created its promise. A synchronous throw
          // rejects that promise and also escapes connect().
          process.nextTick(() => callback(error, undefined, () => undefined));
          return;
        }
        return Promise.reject(error);
      }
      logWorkerFault('main.database.nested-checkout', error);
    }
    if (typeof callback === 'function') {
      // pool.query checks a client out and releases it before resolving, so
      // the caller is not holding a connection across the await.
      return original(callback);
    }
    if (nested) return original() as Promise<PoolClient>;
    adoptHold(pool);
    let pending: Promise<PoolClient>;
    try {
      pending = original() as Promise<PoolClient>;
    } catch (error) {
      releaseHold(pool);
      throw error;
    }
    let released = false;
    const clear = () => {
      if (released) return;
      released = true;
      releaseHold(pool);
    };
    void pending.then(client => {
      const release = client.release.bind(client);
      client.release = (err?: Error | boolean) => {
        clear();
        release(err);
      };
    }, clear);
    return pending;
  };
  pool.connect = connect as Pool['connect'];
}

/** Startup options carrying the bounds, followed by any caller options. */
export function connectionBoundOptions(extra?: string, bounds: ConnectionBounds = CONNECTION_BOUNDS): string {
  return [`-c lock_timeout=${bounds.lockTimeout}`,
    `-c idle_in_transaction_session_timeout=${bounds.idleInTransactionSessionTimeout}`,
    `-c transaction_timeout=${bounds.transactionTimeout}`,
    ...(extra ? [extra] : [])].join(' ');
}

/**
 * A pool whose connections carry the bounds. The server ends a connection that
 * outlives them, and pg-pool drops its own error listener while a client is
 * checked out, so an idle-in-transaction kill would surface as an unhandled
 * client error and take the process down; keep one listener per client.
 */
export function boundedPool(config: PoolConfig, bounds: ConnectionBounds = CONNECTION_BOUNDS): Pool {
  const pool = new Pool({
    ...config,
    connectionTimeoutMillis: checkoutWait(config.connectionTimeoutMillis),
    options: connectionBoundOptions(config.options, bounds),
  });
  const failed = (error: Error) => logWorkerFault('main.database.connection', error);
  pool.on('error', failed);
  pool.on('connect', client => { client.on('error', failed); });
  trackNestedCheckout(pool);
  return pool;
}
