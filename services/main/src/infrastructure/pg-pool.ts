import { AsyncLocalStorage } from 'node:async_hooks';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, trace } from '@opentelemetry/api';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import { observeStatementPool } from './statement-cost.ts';
import { currentWorkerTick } from '../worker-tick.ts';

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
const CHECKOUT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Same shape as a worker tick name: a short label, never a payload. */
const CHECKOUT_TICK = /^[A-Za-z][\w.:-]{0,80}$/;
/** OpenTelemetry trace id. The all-zero id is the inactive span, not a request. */
const CHECKOUT_REQUEST = /^[0-9a-f]{32}$/;

export interface NestedPoolCheckoutDetail {
  outers?: readonly string[];
  inner?: string;
  pool?: string;
  repeats?: number;
  /** When the nested checkout was observed, UTC. */
  at?: string;
  /** Worker tick that held or requested the connection, when one is running. */
  tick?: string;
  /** Active request trace id, when a request span is in scope. */
  request?: string;
}

/** The caller already holds a client from this pool and asked for another. */
export class NestedPoolCheckoutError extends Error {
  readonly outers: readonly string[];
  readonly inner: string;
  readonly pool?: string;
  readonly repeats?: number;
  readonly at?: string;
  readonly tick?: string;
  readonly request?: string;

  constructor(detail: NestedPoolCheckoutDetail = {}) {
    super('Nested PostgreSQL pool checkout');
    this.name = 'NestedPoolCheckoutError';
    this.outers = (detail.outers ?? []).slice(0, CHECKOUT_OUTER_LIMIT).map(acceptedOrigin);
    this.inner = acceptedOrigin(detail.inner);
    if (detail.pool !== undefined && POOL_IDENTITY.test(detail.pool)) this.pool = detail.pool;
    if (typeof detail.repeats === 'number' && Number.isFinite(detail.repeats) && detail.repeats > 0) {
      this.repeats = Math.trunc(detail.repeats);
    }
    if (detail.at !== undefined && CHECKOUT_AT.test(detail.at)) this.at = detail.at;
    if (detail.tick !== undefined && CHECKOUT_TICK.test(detail.tick)) this.tick = detail.tick;
    if (detail.request !== undefined && CHECKOUT_REQUEST.test(detail.request)
      && detail.request !== '0'.repeat(32)) this.request = detail.request;
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

/** QA starts services and owner tests with REZICS_NESTED_POOL_CHECKOUT=throw.
 * Production reports in log mode. Tests can override the mode locally to
 * exercise diagnostic reporting, then restore the harness-selected mode. */
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

/** The request's trace id when a span is active. Absent outside a request. */
function activeRequestTrace(): string | undefined {
  const traceId = trace.getSpan(context.active())?.spanContext().traceId;
  if (!traceId || !CHECKOUT_REQUEST.test(traceId) || traceId === '0'.repeat(32)) return undefined;
  return traceId;
}

export interface SqlWorkMeter {
  readonly starts: number;
  readonly released: number;
  readonly active: number;
  readonly pending: number;
  readonly lastStartAt: number | null;
  readonly zeroSince: number | null;
}

/** Private owner transitions. Trace ids come from the acquiring caller's actual
 * context, never from SQL, connection options or a later releasing caller. */
export interface SqlWorkEvent {
  readonly kind: 'snapshot' | 'pending' | 'active' | 'released';
  readonly checkout: number | null;
  readonly trace: string | undefined;
  readonly at: number;
  readonly complete: boolean;
  readonly totals: SqlWorkMeter;
}
export type SqlWorkObserver = (event: SqlWorkEvent) => void | Promise<void>;
export interface SqlPoolObservation {
  status(): Readonly<{ attached: boolean; complete: boolean; failures: number;
    dropped: number; pendingNotifications: number }>;
  detach(): void;
  drain(): Promise<void>;
}
interface SqlSubscriber {
  observer?: SqlWorkObserver;
  complete: boolean;
  failures: number;
  dropped: number;
  notifications: number;
  drained?: () => void;
  drain?: Promise<void>;
}
interface SqlWorkObservation {
  subscribers: Set<SqlSubscriber>;
  meter: { -readonly [K in keyof SqlWorkMeter]: SqlWorkMeter[K] };
}
interface SqlPoolOwner { started: boolean; observation?: SqlWorkObservation }
const sqlPoolOwners = new WeakMap<Pool, SqlPoolOwner>();
const SQL_OBSERVER_LIMIT = 8;

export interface SqlPoolCreationObservation {
  status(): Readonly<{ attached: boolean; complete: boolean; failures: number; poolsSeen: number }>;
  detach(): void;
}
type SqlPoolCreationSubscriber = { observer?: (pool: Pool) => void; complete: boolean; failures: number; poolsSeen: number };
const sqlPoolCreationSubscribers = new Set<SqlPoolCreationSubscriber>();
let sqlPoolsConstructed = 0;
/** Optional process-owned observer installed by a preload before the relay
 * constructs any pools. No Pool is retained by this registry. A late attach or
 * throwing/async consumer permanently loses complete preconstructor coverage. */
export function observeSqlPoolCreation(observer: (pool: Pool) => void): SqlPoolCreationObservation {
  if (sqlPoolCreationSubscribers.size >= SQL_OBSERVER_LIMIT) throw new Error('SQL pool creation observer limit reached');
  const state: SqlPoolCreationSubscriber = { observer, complete: sqlPoolsConstructed === 0, failures: 0, poolsSeen: 0 };
  sqlPoolCreationSubscribers.add(state);
  return { status: () => Object.freeze({ attached: !!state.observer, complete: state.complete && state.failures === 0,
    failures: state.failures, poolsSeen: state.poolsSeen }),
  detach: () => { state.observer = undefined; sqlPoolCreationSubscribers.delete(state); } };
}
function notifySqlPoolCreation(pool: Pool) {
  sqlPoolsConstructed++;
  for (const state of sqlPoolCreationSubscribers) {
    state.poolsSeen++;
    try {
      const result = (state.observer as ((pool: Pool) => unknown) | undefined)?.(pool);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        state.failures++; void Promise.resolve(result).catch(() => {});
      }
    } catch { state.failures++; }
  }
}

const SQL_OBSERVER_PENDING_LIMIT = 64;

function sqlNotification(subscriber: SqlSubscriber, event: SqlWorkEvent): void {
  if (!subscriber.observer) return;
  if (subscriber.notifications >= SQL_OBSERVER_PENDING_LIMIT) { subscriber.dropped++; return; }
  try {
    const pending = subscriber.observer(Object.freeze({ ...event,
      complete: event.complete && subscriber.complete && subscriber.failures === 0 && subscriber.dropped === 0 }));
    if (pending) {
      subscriber.notifications++;
      void Promise.resolve(pending).catch(() => { subscriber.failures++; }).finally(() => {
        if (--subscriber.notifications === 0) { subscriber.drained?.(); subscriber.drained = undefined; subscriber.drain = undefined; }
      });
    }
  } catch { subscriber.failures++; }
}

/** Attach to the existing bounded pool before its first checkout. Late or
 * interrupted coverage stays incomplete, even when its partial counters are zero.
 * No history, Request, SQL or parameters are retained. detach stops delivery;
 * drain waits only for already returned observer promises. The consumer must
 * then drain/verify/close its own bounded sink and check status for lost events. */
export function observeSqlPool(pool: Pool, observer: SqlWorkObserver): SqlPoolObservation {
  const owner = sqlPoolOwners.get(pool);
  if (!owner) throw new Error('SQL observation requires the actual bounded pool');
  const state = owner.observation ??= { subscribers: new Set(), meter: {
    starts: 0, released: 0, active: 0, pending: 0, lastStartAt: null,
    zeroSince: owner.started ? null : Date.now(),
  } };
  if (state.subscribers.size >= SQL_OBSERVER_LIMIT) throw new Error('SQL observer limit reached');
  const subscriber: SqlSubscriber = { observer, complete: !owner.started, failures: 0, dropped: 0, notifications: 0 };
  state.subscribers.add(subscriber);
  sqlNotification(subscriber, { kind: 'snapshot', checkout: null, trace: undefined,
    at: Date.now(), complete: subscriber.complete, totals: Object.freeze({ ...state.meter }) });
  return {
    status: () => Object.freeze({ attached: !!subscriber.observer,
      complete: subscriber.complete && subscriber.failures === 0 && subscriber.dropped === 0,
      failures: subscriber.failures, dropped: subscriber.dropped, pendingNotifications: subscriber.notifications }),
    detach: () => {
      subscriber.observer = undefined;
      state.subscribers.delete(subscriber);
      if (!state.subscribers.size && owner.observation === state) owner.observation = undefined;
    },
    drain: () => {
      if (!subscriber.notifications) return Promise.resolve();
      return subscriber.drain ??= new Promise<void>(resolve => { subscriber.drained = resolve; });
    },
  };
}

function beginSqlCheckout(pool: Pool) {
  const owner = sqlPoolOwners.get(pool)!;
  owner.started = true;
  const state = owner.observation;
  if (!state) return;
  let trace = activeRequestTrace();
  const checkout = ++state.meter.starts;
  state.meter.pending++;
  state.meter.lastStartAt = Date.now();
  state.meter.zeroSince = null;
  let phase: 'pending' | 'active' | 'released' = 'pending';
  const emit = (kind: SqlWorkEvent['kind']) => {
    const event = Object.freeze({ kind, checkout, trace, at: Date.now(), complete: true,
      totals: Object.freeze({ ...state.meter }) });
    for (const subscriber of [...state.subscribers]) sqlNotification(subscriber, event);
  };
  const released = () => {
    if (phase === 'released') return;
    state.meter[phase]--;
    phase = 'released';
    state.meter.released++;
    if (!state.meter.active && !state.meter.pending) state.meter.zeroSince = Date.now();
    emit('released');
    trace = undefined;
  };
  emit('pending');
  return {
    released,
    acquired: (client: PoolClient) => {
      state.meter.pending--;
      state.meter.active++;
      phase = 'active';
      emit('active');
      const release = client.release;
      let returned = false, listening = false;
      const driver = client as PoolClient & { _ended?: boolean; _ending?: boolean;
        _activeQuery?: unknown; _queryQueue?: unknown[]; _sentQueryQueue?: unknown[];
        readyForQuery?: boolean };
      const idle = () => {
        // pg 8's real protocol/queue state, including query_timeout callbacks
        // that have returned while the wire query is still executing. Unknown
        // client implementations cannot establish settled/known-zero work.
        return driver._ended === true || (driver._ending !== true
          && driver.readyForQuery === true && '_activeQuery' in driver && driver._activeQuery == null
          && driver._queryQueue?.length === 0 && driver._sentQueryQueue?.length === 0);
      };
      const retire = () => {
        client.removeListener('drain', settled);
        client.removeListener('end', settled);
        released();
      };
      const settled = () => {
        if (returned && idle() && phase !== 'released') retire();
      };
      client.release = function (this: PoolClient, ...args: Parameters<PoolClient['release']>) {
        if (!listening) {
          listening = true;
          client.on('drain', settled);
          client.on('end', settled);
        }
        // A throwing/double release keeps the driver's error and cannot invent
        // settlement. No query/callback/transaction overload is replaced.
        const wasIdle = idle();
        const result = Reflect.apply(release, this, args);
        returned = true;
        // release may synchronously lend this idle client to a queued callback
        // that starts different SQL before the original release returns.
        if (wasIdle && driver._ending !== true) retire();
        else {
          settled();
          // pg delivers a fresh connect callback before finishing its initial
          // readyForQuery, with no drain until SQL has run. Recheck once after
          // that callback unwinds, using the same protocol and queue fence.
          queueMicrotask(settled);
        }
        return result;
      };
    },
  };
}

function nestedCheckoutError(pool: Pool, holds: readonly CheckoutHold[]): NestedPoolCheckoutError {
  const tick = currentWorkerTick();
  const request = activeRequestTrace();
  return new NestedPoolCheckoutError({
    outers: holds.slice(0, CHECKOUT_OUTER_LIMIT).map(hold => formatCheckoutOrigin(hold.origin)),
    inner: formatCheckoutOrigin(captureCheckoutOrigin()),
    pool: poolIdentity(pool),
    at: new Date().toISOString(),
    ...(tick ? { tick } : {}),
    ...(request ? { request } : {}),
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
      at: error.at, tick: error.tick, request: error.request,
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
  done: PoolClient['release'],
) => void;

function trackNestedCheckout(pool: Pool): void {
  const original = pool.connect.bind(pool) as Pool['connect'];
  const connect = (callback?: ConnectCallback) => {
    const observation = beginSqlCheckout(pool);
    const nested = [...(checkoutHolds.getStore() ?? [])].filter(
      (hold) => hold.pool === pool && hold.active,
    );
    if (nested.length > 0) {
      const error = nestedCheckoutError(pool, nested);
      if (checkoutMode === 'throw') {
        if (typeof callback === 'function') {
          // pool.query has already created its promise. A synchronous throw
          // rejects that promise and also escapes connect().
          process.nextTick(() => {
            observation?.released();
            callback(error, undefined, () => undefined);
          });
          return;
        }
        observation?.released();
        return Promise.reject(error);
      }
      logReportedCheckout(error);
    }
    if (typeof callback === 'function') {
      // pool.query checks a client out and releases it before resolving, so
      // the caller is not holding a connection across the await. A queued
      // checkout may be delivered by an unrelated request or worker's release;
      // its SQL and callbacks must keep the requesting caller's whole context.
      const resume = AsyncLocalStorage.snapshot();
      try {
        return original((error, client, done) => resume(() => {
          if (client) observation?.acquired(client);
          else observation?.released();
          callback(error, client, client && observation ? client.release : done);
        }));
      } catch (error) {
        observation?.released();
        throw error;
      }
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
      observation?.released();
      throw error;
    }
    // Return this chain so even an immediate release observes the wrapper.
    return pending.then(
      (client) => {
        observation?.acquired(client);
        const release = client.release.bind(client);
        client.release = (err?: Error | boolean) => {
          clear();
          release(err);
        };
        return client;
      },
      (error) => {
        clear();
        observation?.released();
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
  observeStatementPool(pool);
  sqlPoolOwners.set(pool, { started: false });
  trackNestedCheckout(pool);
  notifySqlPoolCreation(pool);
  return pool;
}
