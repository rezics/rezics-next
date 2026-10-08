import { AsyncLocalStorage } from 'node:async_hooks';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const CHECKOUT_ORIGIN_LIMIT = 200;
const CHECKOUT_OUTER_LIMIT = 3;
/** Enough frames to pass this file and a pool.query frame in node_modules. */
const CHECKOUT_STACK_LIMIT = 8;
const CHECKOUT_REPORT_WINDOW_MS = 60_000;
const CHECKOUT_REPORT_LIMIT = 128;
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');
const CHECKOUT_SITE = /^([A-Za-z0-9_./:-]+):(\d{1,7})(?: ([A-Za-z_$][A-Za-z0-9_$.#]*))?$/;
const CHECKOUT_FRAME = /^\s*at (?:async )?(.+)$/;
const POOL_IDENTITY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface NestedPoolCheckoutDetail {
  outers?: readonly string[];
  inner?: string;
  pool?: string;
  repeats?: number;
}

/** The caller already holds a client from this pool and asked for another. */
export class NestedPoolCheckoutError extends Error {
  readonly outers: readonly string[];
  readonly inner: string;
  readonly pool?: string;
  readonly repeats?: number;

  constructor(detail: NestedPoolCheckoutDetail = {}) {
    super('Nested PostgreSQL pool checkout');
    this.name = 'NestedPoolCheckoutError';
    this.outers = (detail.outers ?? []).slice(0, CHECKOUT_OUTER_LIMIT).map(acceptedOrigin);
    this.inner = acceptedOrigin(detail.inner);
    if (detail.pool !== undefined && POOL_IDENTITY.test(detail.pool)) this.pool = detail.pool;
    if (typeof detail.repeats === 'number' && Number.isFinite(detail.repeats) && detail.repeats > 0) {
      this.repeats = Math.trunc(detail.repeats);
    }
  }
}

/** A caller location is a repository-relative path and line, plus a function name when
 * the frame has one. Anything else, including query text, becomes `unknown`. */
function acceptedOrigin(value: string | undefined): string {
  const match = typeof value === 'string' ? CHECKOUT_SITE.exec(value) : null;
  if (!match?.[1] || !match[2]) return 'unknown';
  const site = `${match[1]}:${match[2]}`;
  const named = match[3] ? `${site} ${match[3]}` : site;
  if (named.length <= CHECKOUT_ORIGIN_LIMIT) return named;
  if (site.length <= CHECKOUT_ORIGIN_LIMIT) return site;
  const tail = site.slice(-CHECKOUT_ORIGIN_LIMIT);
  return CHECKOUT_SITE.test(tail) ? tail : 'unknown';
}

export type NestedPoolCheckoutMode = 'log' | 'throw';

interface CheckoutHold {
  pool: Pool;
  active: boolean;
  /** Captured at adoption. `.stack` stays unread until a nested checkout is reported. */
  origin: Error;
}
const checkoutHolds = new AsyncLocalStorage<ReadonlySet<CheckoutHold>>();
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

let checkoutReportNow: () => number = () => Date.now();
const checkoutReports = new Map<string, { at: number; repeats: number }>();

/** Tests move the clock that bounds repeated nested-checkout reports. */
export function setNestedCheckoutReportClock(now?: () => number): void {
  checkoutReportNow = now ?? (() => Date.now());
  checkoutReports.clear();
}

function captureCheckoutOrigin(): Error {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = CHECKOUT_STACK_LIMIT;
  try {
    // Bun stores the limit now and formats `.stack` on first read.
    return new Error('checkout origin');
  } finally {
    Error.stackTraceLimit = previous;
  }
}

function repositoryFrame(file: string): string | undefined {
  let absolute = file;
  if (absolute.startsWith('file://')) {
    try { absolute = fileURLToPath(absolute); }
    catch { return undefined; }
  }
  if (!absolute.startsWith('/')) return undefined;
  const relativePath = relative(REPOSITORY_ROOT, absolute);
  const portable = relativePath.split(sep).join('/');
  if (!portable || portable.startsWith('..') || portable.split('/').includes('node_modules')) return undefined;
  if (portable === 'services/main/src/infrastructure/pg-pool.ts') return undefined;
  return portable;
}

function frameOrigin(line: string): string | undefined {
  const wrapped = CHECKOUT_FRAME.exec(line);
  if (!wrapped?.[1]) return undefined;
  const location = /^(?:async )?(?:(.+?) )?\(?(.+?):(\d+):\d+\)?$/.exec(wrapped[1]);
  if (!location?.[2] || !location[3]) return undefined;
  const file = repositoryFrame(location[2]);
  if (!file) return undefined;
  const name = location[1];
  const safeName = name !== undefined && /^[A-Za-z_$][A-Za-z0-9_$.#]*$/.test(name) ? name : undefined;
  return acceptedOrigin(safeName ? `${file}:${location[3]} ${safeName}` : `${file}:${location[3]}`);
}

function formatCheckoutOrigin(trace: Error): string {
  for (const line of (trace.stack ?? '').split('\n')) {
    const origin = frameOrigin(line);
    if (origin && origin !== 'unknown') return origin;
  }
  return 'unknown';
}

/** The database name already on the pool. Connection strings contribute only that
 * name: user, password, host and query text are not an identity. */
function poolIdentity(pool: Pool): string | undefined {
  const connectionString = pool.options.connectionString;
  if (typeof connectionString === 'string') {
    const named = databaseName(connectionString);
    if (named) return named;
  }
  const database = pool.options.database;
  return typeof database === 'string' && POOL_IDENTITY.test(database) ? database : undefined;
}

function databaseName(connectionString: string): string | undefined {
  if (!connectionString.includes('://')) {
    const keyword = /(?:^|\s)dbname=([A-Za-z][A-Za-z0-9_]{0,63})(?:\s|$)/.exec(connectionString);
    return keyword?.[1];
  }
  try {
    const name = decodeURIComponent(new URL(connectionString).pathname).replace(/^\/+/, '');
    return POOL_IDENTITY.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function nestedCheckoutError(pool: Pool, holds: readonly CheckoutHold[]): NestedPoolCheckoutError {
  return new NestedPoolCheckoutError({
    outers: holds.slice(0, CHECKOUT_OUTER_LIMIT).map(hold => formatCheckoutOrigin(hold.origin)),
    inner: formatCheckoutOrigin(captureCheckoutOrigin()),
    pool: poolIdentity(pool),
  });
}

function logReportedCheckout(error: NestedPoolCheckoutError): void {
  const key = `${error.outers.join('\0')}\0${error.inner}`;
  const now = checkoutReportNow();
  const existing = checkoutReports.get(key);
  if (existing && now - existing.at < CHECKOUT_REPORT_WINDOW_MS) {
    existing.repeats += 1;
    return;
  }
  const repeats = existing?.repeats ?? 0;
  if (!existing && checkoutReports.size >= CHECKOUT_REPORT_LIMIT) {
    const oldest = checkoutReports.keys().next().value;
    if (oldest !== undefined) checkoutReports.delete(oldest);
  }
  checkoutReports.set(key, { at: now, repeats: 0 });
  logWorkerFault('main.database.nested-checkout', repeats > 0
    ? new NestedPoolCheckoutError({
      outers: error.outers, inner: error.inner, pool: error.pool, repeats,
    })
    : error);
}

function checkoutWait(requested: number | undefined): number {
  if (requested === undefined || requested <= 0) return CONNECTION_CHECKOUT_WAIT_MS;
  return requested;
}

function adoptHold(pool: Pool): CheckoutHold {
  const hold: CheckoutHold = { pool, active: true, origin: captureCheckoutOrigin() };
  // A sibling may inherit this snapshot, but a child must not add its checkout
  // to the sibling's ownership. Releases retire the captured checkout token.
  const inherited = [...(checkoutHolds.getStore() ?? [])].filter((item) => item.active);
  // enterWith during the synchronous connect() sticks across the caller's
  // await. Wrapping the resolved promise does not, on this runtime.
  checkoutHolds.enterWith(new Set([...inherited, hold]));
  return hold;
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

function trackNestedCheckout(pool: Pool): void {
  const original = pool.connect.bind(pool) as Pool['connect'];
  const connect = (callback?: ConnectCallback) => {
    const nested = [...(checkoutHolds.getStore() ?? [])].filter(
      (hold) => hold.pool === pool && hold.active,
    );
    if (nested.length > 0) {
      const error = nestedCheckoutError(pool, nested);
      if (checkoutMode === 'throw') {
        if (typeof callback === 'function') {
          // pool.query has already created its promise. A synchronous throw
          // rejects that promise and also escapes connect().
          process.nextTick(() => callback(error, undefined, () => undefined));
          return;
        }
        return Promise.reject(error);
      }
      logReportedCheckout(error);
    }
    if (typeof callback === 'function') {
      // pool.query checks a client out and releases it before resolving, so
      // the caller is not holding a connection across the await.
      return original(callback);
    }
    const hold = adoptHold(pool);
    const clear = () => {
      hold.active = false;
    };
    let pending: Promise<PoolClient>;
    try {
      pending = original() as Promise<PoolClient>;
    } catch (error) {
      clear();
      throw error;
    }
    // Return this chain so even an immediate release observes the wrapper.
    return pending.then(
      (client) => {
        const release = client.release.bind(client);
        client.release = (err?: Error | boolean) => {
          clear();
          release(err);
        };
        return client;
      },
      (error) => {
        clear();
        throw error;
      },
    );
  };
  pool.connect = connect as Pool['connect'];
}

/** Startup options carrying the bounds, followed by any caller options. */
export function connectionBoundOptions(
  extra?: string,
  bounds: ConnectionBounds = CONNECTION_BOUNDS,
): string {
  return [
    `-c lock_timeout=${bounds.lockTimeout}`,
    `-c idle_in_transaction_session_timeout=${bounds.idleInTransactionSessionTimeout}`,
    `-c transaction_timeout=${bounds.transactionTimeout}`,
    ...(extra ? [extra] : []),
  ].join(' ');
}

/**
 * A pool whose connections carry the bounds. The server ends a connection that
 * outlives them, and pg-pool drops its own error listener while a client is
 * checked out, so an idle-in-transaction kill would surface as an unhandled
 * client error and take the process down; keep one listener per client.
 */
export function boundedPool(
  config: PoolConfig,
  bounds: ConnectionBounds = CONNECTION_BOUNDS,
): Pool {
  const pool = new Pool({
    ...config,
    connectionTimeoutMillis: checkoutWait(config.connectionTimeoutMillis),
    options: connectionBoundOptions(config.options, bounds),
  });
  const failed = (error: Error) => logWorkerFault('main.database.connection', error);
  pool.on('error', failed);
  pool.on('connect', (client) => {
    client.on('error', failed);
    // pg delivers server query errors through this protocol event, not the
    // client's connection-error event. Observe before the driver's handler so
    // even a caught/translated query failure is recorded. One listener per
    // connection covers pool.query, borrowed clients and every query form
    // without wrapping callbacks, promises or query objects.
    client.connection.prependListener('errorMessage', (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === '40P01') {
        logWorkerFault('main.database.deadlock', error);
      }
    });
  });
  trackNestedCheckout(pool);
  return pool;
}
