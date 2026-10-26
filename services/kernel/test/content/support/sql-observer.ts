import { types, type Pool, type PoolClient } from 'pg';

export interface SqlExecution {
  readonly statement: string;
  readonly parameters: readonly unknown[];
  /** PostgreSQL backend PID for the connection that executed the statement. */
  readonly connectionId: number;
  /** Timestamp recorded at the actual query boundary. */
  readonly executedAt: string;
}

/** Decode the native UUID-array binding without losing the single-resource contract. */
export function permissionResourceId(execution: SqlExecution, parameters: readonly string[]): string {
  const value = execution.parameters[parameters.indexOf('resource_ids')];
  // pg-types' TypeId enum omits array OIDs; 2951 is PostgreSQL's UUID array.
  const ids: unknown =
    typeof value === 'string'
      ? types.getTypeParser(2951 as Parameters<typeof types.getTypeParser>[0], 'text')(value)
      : value;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string')
    throw new Error('Expected one resource in the observed permission statement');
  return ids[0];
}

export interface SqlMatch {
  /** Exact statement text observed at the driver boundary. */
  readonly statement: string;
  /** One-based matching execution to select; defaults to the next matching execution. */
  readonly occurrence?: number;
}

export type SqlBoundary = 'before' | 'after';

export interface SqlFaultHook {
  readonly match: SqlMatch;
  readonly boundary: SqlBoundary;
  readonly error: Error;
}

export interface SqlBarrier {
  readonly match: SqlMatch;
  readonly boundary: SqlBoundary;
  /** Resolves when the real query reaches the selected boundary. */
  readonly entered: Promise<SqlExecution>;
  /** Releases the query after entered resolves. */
  release(): void;
}

export interface SqlObserver {
  /** Executed statements and bound parameters in observed order. */
  readonly records: readonly SqlExecution[];
  /** Install a one-shot failure at an actual query boundary. */
  armFault(hook: SqlFaultHook): void;
  /** Pause a real query at a selected boundary for deterministic coordination. */
  hold(match: SqlMatch, boundary: SqlBoundary): SqlBarrier;
  close(): Promise<void>;
}

type Callback = (error: unknown, result?: unknown) => void;
type QueryConfig = { text?: string; values?: unknown[]; callback?: Callback };
type NativeQuery = QueryConfig & {
  submit: Function;
  handleReadyForQuery: (...args: unknown[]) => void;
  handleError: (error: unknown, ...args: unknown[]) => void;
};
type NativeClient = PoolClient & { processID: number; _Promise: PromiseConstructor };
type Hook = {
  remaining: number;
  boundary: SqlBoundary;
  error?: Error;
  enter?: (execution: SqlExecution) => void;
  wait?: Promise<void>;
};

// Keep driver values as values: never serialize parameters or invoke toPostgres.
function snapshot(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Date) return new Date(value);
  if (ArrayBuffer.isView(value)) return structuredClone(value);
  if (
    Array.isArray(value) ||
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  ) {
    const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) descriptor.value = snapshot(descriptor.value, seen);
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  }
  return value;
}

/** Observe only this pool's native clients; pool.query delegates to the same boundary. */
export function observeSql(pool: Pool): SqlObserver {
  const records: SqlExecution[] = [];
  const hooks = new Map<string, Hook[]>();
  const releases = new Set<() => void>();
  const restorations = new Map<PoolClient, () => void>();
  let closed = false;

  function install(match: SqlMatch, hook: Omit<Hook, 'remaining'>): void {
    if (closed) throw new Error('SQL observer is closed');
    const remaining = match.occurrence ?? 1;
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw new RangeError('SQL occurrence must be positive');
    const pending = hooks.get(match.statement) ?? [];
    pending.push({ ...hook, remaining });
    hooks.set(match.statement, pending);
  }

  function select(statement: string): Hook[] {
    const pending = hooks.get(statement);
    if (!pending) return [];
    const selected = pending.filter((hook) => --hook.remaining === 0);
    const rest = pending.filter((hook) => hook.remaining > 0);
    if (rest.length) hooks.set(statement, rest);
    else hooks.delete(statement);
    return selected;
  }

  function boundary(selected: Hook[], at: SqlBoundary, execution: SqlExecution): Promise<void> | undefined {
    const matching = selected.filter((hook) => hook.boundary === at);
    if (closed || !matching.length) return;
    for (const hook of matching) hook.enter?.(execution);
    const waits = matching.flatMap((hook) => (hook.wait ? [hook.wait] : []));
    const fault = matching.find((hook) => hook.error)?.error;
    if (waits.length)
      return Promise.all(waits).then(() => {
        if (!closed && fault) throw fault;
      });
    if (fault) return Promise.reject(fault);
  }

  function wrap(client: PoolClient): void {
    if (closed || restorations.has(client)) return;
    const native = client as NativeClient;
    const original = client.query;
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    // Only a before hold delays dispatch. Later calls on this client must stay behind it,
    // while other clients and already submitted native queries remain independent.
    let dispatch: Promise<void> | undefined;
    const wrapped = function (this: PoolClient, ...args: unknown[]): unknown {
      if (closed) return Reflect.apply(original, this, args);
      const config = args[0] as string | QueryConfig | null;
      if (config == null) return Reflect.apply(original, this, args);
      const options = typeof config === 'string' ? { text: config } : config;
      const query =
        typeof (options as Partial<NativeQuery>).submit === 'function' ? (options as NativeQuery) : undefined;
      const suppliedCallback = typeof args[1] === 'function' ? args[1] : args[2];
      const callback = query ? (options.callback ?? suppliedCallback) : (suppliedCallback ?? options.callback);
      if (callback != null && typeof callback !== 'function') return Reflect.apply(original, this, args);
      const values = !query && args[1] && typeof args[1] !== 'function' ? args[1] : options.values;
      let complete: Callback;
      const result = query
        ? query
        : callback
          ? undefined
          : new native._Promise((resolve, reject) => {
              complete = (error, value) => (error ? reject(error) : resolve(value));
            });
      if (query)
        complete = (error) =>
          callback ? (callback as Callback).call(query, error) : query.handleError(error, client.connection);
      else if (callback) complete = callback as Callback;
      const run = (): Promise<void> | undefined => {
        const execution: SqlExecution = {
          statement: options.text ?? '',
          parameters: Array.isArray(values) ? values.map((value) => snapshot(value)) : [],
          connectionId: native.processID,
          executedAt: new Date().toISOString(),
        };
        const selected = closed ? [] : select(execution.statement);
        if (!closed) records.push(execution);
        const done = function (this: unknown, error: unknown, value?: unknown): void {
          const after = boundary(selected, 'after', execution);
          if (after) {
            void after.then(
              () => complete.call(this, error, value),
              (fault: unknown) => complete.call(this, error ?? fault, value),
            );
          } else complete.call(this, error, value);
        };
        const submit = (): void => {
          try {
            // Leave all query config options, values and native decoding to pg.
            if (query) {
              // Native Query objects return themselves and deliver callbacks/events through
              // these handlers. Delay completion without replacing their result machinery.
              const ready = query.handleReadyForQuery;
              const failed = query.handleError;
              const readyDescriptor = Object.getOwnPropertyDescriptor(query, 'handleReadyForQuery');
              const errorDescriptor = Object.getOwnPropertyDescriptor(query, 'handleError');
              const restore = (): void => {
                if (readyDescriptor) Object.defineProperty(query, 'handleReadyForQuery', readyDescriptor);
                else Reflect.deleteProperty(query, 'handleReadyForQuery');
                if (errorDescriptor) Object.defineProperty(query, 'handleError', errorDescriptor);
                else Reflect.deleteProperty(query, 'handleError');
              };
              const finish = (error: unknown, args: unknown[]): void => {
                const deliver = (fault?: unknown): void => {
                  restore();
                  if (error || fault) failed.call(query, error ?? fault, ...args);
                  else ready.apply(query, args);
                };
                const after = boundary(selected, 'after', execution);
                if (after) void after.then(() => deliver(), deliver);
                else deliver();
              };
              query.handleReadyForQuery = (...args) => finish(undefined, args);
              query.handleError = (error, ...args) => finish(error, args);
              Reflect.apply(original, client, args);
            } else {
              // pg normalizes callback/values into config in place. Keep the observer's
              // completion callback out of caller-owned, reusable query configurations.
              const transport = typeof config === 'string' ? config : { ...config };
              Reflect.apply(original, client, [transport, values, done]);
            }
          } catch (error) {
            complete(error);
          }
        };
        const before = boundary(selected, 'before', execution);
        if (before)
          return before.then(submit, (error: unknown) => {
            complete(error);
          });
        submit();
      };
      const pending = dispatch ? dispatch.then(run) : run();
      if (pending) {
        dispatch = pending;
        void pending.then(() => {
          if (dispatch === pending) dispatch = undefined;
        });
      }
      return result;
    } as PoolClient['query'];
    client.query = wrapped;
    restorations.set(client, () => {
      if (client.query !== wrapped) return;
      if (descriptor) Object.defineProperty(client, 'query', descriptor);
      else Reflect.deleteProperty(client, 'query');
    });
  }

  function restore(client: PoolClient): void {
    restorations.get(client)?.();
    restorations.delete(client);
  }

  pool.on('connect', wrap);
  pool.on('acquire', wrap);
  pool.on('remove', restore);
  // pg exposes no public enumeration of clients already checked out at installation.
  for (const client of (pool as Pool & { _clients: PoolClient[] })._clients) wrap(client);

  return {
    records,
    armFault(hook) {
      install(hook.match, { boundary: hook.boundary, error: hook.error });
    },
    hold(match, at) {
      let enter!: (execution: SqlExecution) => void;
      let unblock!: () => void;
      const entered = new Promise<SqlExecution>((resolve) => {
        enter = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const release = (): void => {
        releases.delete(release);
        unblock();
      };
      install(match, { boundary: at, enter, wait });
      releases.add(release);
      return { match, boundary: at, entered, release };
    },
    async close() {
      if (closed) return;
      closed = true;
      hooks.clear();
      for (const release of releases) release();
      pool.removeListener('connect', wrap);
      pool.removeListener('acquire', wrap);
      pool.removeListener('remove', restore);
      for (const client of restorations.keys()) restore(client);
    },
  };
}
