import type { Pool, PoolClient } from 'pg';
import type { Access } from '../../../src/request/access.ts';
import { ProblemError } from '../../../src/http/problem.ts';

type InterceptMode = 'pause' | 'fail';

export type WatchAccessCounts = Readonly<{ preparations: number; evaluations: number }>;

/** Count real Access preparations and evaluations around mounted watch requests. */
export function captureWatchAccess(access: Access) {
  const counts = { preparations: 0, evaluations: 0 };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const prepare = new Set(['prepareReadDecisions', 'prepare', 'preparePage']);
  const evaluate = new Set(['authorize', 'authorizePage', 'authorizeExplicit']);
  for (const name of [...prepare, ...evaluate]) {
    const original = Object.getOwnPropertyDescriptor(access, name);
    const method = (access as unknown as Record<string, unknown>)[name];
    if (typeof method !== 'function') continue;
    originals.set(name, original);
    Object.defineProperty(access, name, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        if (prepare.has(name)) counts.preparations++;
        else counts.evaluations++;
        return Reflect.apply(method, this, args);
      },
    });
  }
  return {
    reset() {
      counts.preparations = 0;
      counts.evaluations = 0;
    },
    snapshot(): WatchAccessCounts {
      return { ...counts };
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(access, name, descriptor);
        else Reflect.deleteProperty(access, name);
      }
    },
  };
}

export function watchPageByteEvidence(page: unknown, serializedUtf8Bytes?: number) {
  const value = page as { items?: readonly unknown[] };
  const serialized = JSON.stringify(page);
  const retained = JSON.stringify(value.items ?? []);
  const copied = JSON.stringify(structuredClone(page));
  if (serialized === undefined || retained === undefined || copied === undefined)
    throw new TypeError('Watch page is not JSON serializable');
  return {
    materializedDtoBytes: Buffer.byteLength(serialized, 'utf8'),
    retainedItemBytes: Buffer.byteLength(retained, 'utf8'),
    copiedDtoBytes: Buffer.byteLength(copied, 'utf8'),
    serializedUtf8Bytes: serializedUtf8Bytes ?? Buffer.byteLength(serialized, 'utf8'),
  };
}

/** Pause or fail one native thread snapshot after earlier page rows have finished disclosure. */
export function interceptThreadSnapshot(pool: Pool, threadId: string, mode: InterceptMode) {
  const mutable = pool as unknown as { connect: (...args: unknown[]) => unknown };
  const original = mutable.connect.bind(pool);
  let entered!: () => void;
  let release!: () => void;
  let reached = false;
  let closed = false;
  const reachedSnapshot = new Promise<void>((resolve) => (entered = resolve));
  const resumed = new Promise<void>((resolve) => (release = resolve));

  mutable.connect = (...args) => {
    const connection = original(...args);
    if (args.length || !(connection instanceof Promise)) return connection;
    return connection.then((client: PoolClient) => {
      if (closed) return client;
      const query = client.query;
      client.query = new Proxy(query, {
        apply(target, thisArg, queryArgs) {
          const statement = queryArgs[0] as string | { text?: string; values?: readonly unknown[] };
          const sql = typeof statement === 'string' ? statement : (statement.text ?? '');
          const values =
            (Array.isArray(queryArgs[1]) ? queryArgs[1] : undefined) ??
            (typeof statement === 'string' ? undefined : statement.values) ??
            [];
          if (!closed && !reached && sql.includes('content.thread') && values.includes(threadId)) {
            reached = true;
            entered();
            if (mode === 'fail') return Promise.reject(new ProblemError('dependency_unavailable'));
            return resumed.then(() => Reflect.apply(target, thisArg, queryArgs));
          }
          return Reflect.apply(target, thisArg, queryArgs);
        },
      }) as typeof client.query;
      return client;
    });
  };

  return {
    reached: reachedSnapshot,
    release() {
      release();
    },
    restore() {
      if (closed) return;
      closed = true;
      release();
      mutable.connect = original;
    },
  };
}

/** Pause or fail one exact native Board read inside a mounted private watch-page request. */
export function interceptBoardSnapshot(
  pool: Pool,
  boardId: string,
  occurrence: number,
  mode: InterceptMode,
) {
  const mutable = pool as unknown as { connect: (...args: unknown[]) => unknown };
  const original = mutable.connect.bind(pool);
  let entered!: () => void;
  let release!: () => void;
  let matched = 0;
  let reached = false;
  let closed = false;
  const reachedSnapshot = new Promise<void>((resolve) => (entered = resolve));
  const resumed = new Promise<void>((resolve) => (release = resolve));

  mutable.connect = (...args) => {
    const connection = original(...args);
    if (args.length || !(connection instanceof Promise)) return connection;
    return connection.then((client: PoolClient) => {
      if (closed) return client;
      const query = client.query;
      client.query = new Proxy(query, {
        apply(target, thisArg, queryArgs) {
          const statement = queryArgs[0] as string | { text?: string; values?: readonly unknown[] };
          const sql = typeof statement === 'string' ? statement : (statement.text ?? '');
          const values =
            (Array.isArray(queryArgs[1]) ? queryArgs[1] : undefined) ??
            (typeof statement === 'string' ? undefined : statement.values) ??
            [];
          if (!closed && !reached && sql.includes('content.board') && values.includes(boardId)) {
            matched++;
            if (matched === occurrence) {
              reached = true;
              entered();
              if (mode === 'fail') return Promise.reject(new ProblemError('dependency_unavailable'));
              return resumed.then(() => Reflect.apply(target, thisArg, queryArgs));
            }
          }
          return Reflect.apply(target, thisArg, queryArgs);
        },
      }) as typeof client.query;
      return client;
    });
  };

  return {
    reached: reachedSnapshot,
    release() {
      release();
    },
    restore() {
      if (closed) return;
      closed = true;
      release();
      mutable.connect = original;
    },
  };
}

/** Count the companion's initial/final Board point reads and exact selected watch-key reads. */
export function captureBoardWatchPageQueries(pool: Pool, boardId: string) {
  const counts = { boardPointReads: 0, boardPointRows: 0, selectedWatchReads: 0, selectedWatchRows: 0 };
  const mutable = pool as unknown as { connect: (...args: unknown[]) => unknown };
  const original = mutable.connect.bind(pool);
  let closed = false;
  mutable.connect = (...args) => {
    const connection = original(...args);
    if (args.length || !(connection instanceof Promise)) return connection;
    return connection.then((client: PoolClient) => {
      if (closed) return client;
      const query = client.query;
      client.query = new Proxy(query, {
        apply(target, thisArg, queryArgs) {
          const statement = queryArgs[0] as string | { text?: string; values?: readonly unknown[] };
          const sql = typeof statement === 'string' ? statement : (statement.text ?? '');
          const values =
            (Array.isArray(queryArgs[1]) ? queryArgs[1] : undefined) ??
            (typeof statement === 'string' ? undefined : statement.values) ??
            [];
          const boardRead = !closed && values.includes(boardId) && /\bFROM\s+content\.board\b/iu.test(sql);
          const watchRead = !closed && values.includes(boardId) && /\bFROM\s+content\.board_watch\b/iu.test(sql);
          if (boardRead) counts.boardPointReads++;
          if (watchRead) counts.selectedWatchReads++;
          const pending = Reflect.apply(target, thisArg, queryArgs) as Promise<{ rows?: readonly unknown[] }>;
          if (!boardRead && !watchRead) return pending;
          return pending.then((result) => {
            if (boardRead) counts.boardPointRows += result.rows?.length ?? 0;
            if (watchRead) counts.selectedWatchRows += result.rows?.length ?? 0;
            return result;
          });
        },
      }) as typeof client.query;
      return client;
    });
  };

  return {
    reset() {
      counts.boardPointReads = 0;
      counts.boardPointRows = 0;
      counts.selectedWatchReads = 0;
      counts.selectedWatchRows = 0;
    },
    snapshot() {
      return { ...counts };
    },
    restore() {
      if (closed) return;
      closed = true;
      mutable.connect = original;
    },
  };
}
