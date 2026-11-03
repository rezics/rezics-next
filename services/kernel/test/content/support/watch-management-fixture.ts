import type { Pool, PoolClient } from 'pg';
import { ProblemError } from '../../../src/http/problem.ts';

type InterceptMode = 'pause' | 'fail';

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
