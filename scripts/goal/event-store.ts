import type { Database } from 'bun:sqlite';

/** SQLite cannot wait while upgrading a stale read transaction. Retry its whole
 * transaction after rollback; standalone statements can be retried directly. */
export function retryEventDatabase(db: Database, waitMs = 5000): Database {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('Event store wait must be a nonnegative integer');
  db.exec('PRAGMA busy_timeout=0');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let statement = 'BEGIN';
  const locked = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & {code?: string}).code;
    return code?.startsWith('SQLITE_BUSY') === true || code?.startsWith('SQLITE_LOCKED') === true;
  };
  function retry<T>(action: () => T): T {
    const deadline = performance.now() + waitMs;
    for (;;) {
      try { return action(); }
      catch (error) {
        if (db.inTransaction) throw error;
        if (!(error instanceof Error) || !(error as Error & {code?: string}).code?.startsWith('SQLITE_')) throw error;
        const remaining = deadline - performance.now();
        if (!locked(error) || remaining <= 0) {
          throw new Error(`Event store statement ${JSON.stringify(statement)} failed${locked(error) ? ` after waiting ${waitMs} ms` : ''}: ${String(error)}`, {cause:error});
        }
        Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
      }
    }
  }
  return new Proxy(db, {get(target, key) {
    if (key === 'query' || key === 'prepare') return (sql: string, ...args: unknown[]) => {
      const query = retry(() => { statement = sql; return Reflect.apply(target[key], target, [sql, ...args]) as ReturnType<Database['query']>; });
      return new Proxy(query, {get(queryTarget, method) {
        const value = Reflect.get(queryTarget, method, queryTarget) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => retry(() => { statement = sql; return Reflect.apply(value, queryTarget, args) as unknown; });
      }});
    };
    if (key === 'exec' || key === 'run') return (sql: string, ...args: unknown[]) =>
      retry(() => { statement = sql; return Reflect.apply(target[key], target, [sql, ...args]) as unknown; });
    if (key === 'transaction') return (action: (...args: unknown[]) => unknown) => {
      const transaction = target.transaction((...args: unknown[]) => {
        const result = action(...args);
        statement = 'COMMIT';
        return result;
      });
      const invoke = (fn: (...args: unknown[]) => unknown, args: unknown[], begin = 'BEGIN') => retry(() => {
        statement = begin;
        return Reflect.apply(fn, target, args) as unknown;
      });
      return Object.assign((...args: unknown[]) => invoke(transaction, args), {
        deferred: (...args: unknown[]) => invoke(transaction.deferred, args),
        immediate: (...args: unknown[]) => invoke(transaction.immediate, args, 'BEGIN IMMEDIATE'),
        exclusive: (...args: unknown[]) => invoke(transaction.exclusive, args, 'BEGIN EXCLUSIVE'),
        database: db,
      });
    };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === 'function' ? value.bind(target) as unknown : value;
  }});
}
