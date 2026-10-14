import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

interface ContentSession { client: PoolClient; active: boolean; dispose: (failed: boolean) => void }
const sessions = new AsyncLocalStorage<ReadonlyMap<Pool, ContentSession>>();

/** An import holds a session advisory lock across separately committed owner
 * commands. Only that explicitly scoped session may lend its idle connection;
 * ordinary transactions still require an explicit transaction client. */
export function contentSessionClient(pool: Pool): PoolClient | undefined {
  const held = sessions.getStore()?.get(pool);
  if (held && !held.active) throw new Error('Content session has ended');
  return held?.client;
}

export function contentConnection(pool: Pool): Pool | PoolClient {
  return contentSessionClient(pool) ?? pool;
}

/** Sibling requests get independent checkout tracking. A nested import lock
 * borrows the session and leaves its release to the outermost owner. */
export function withContentSession<T>(pool: Pool, work: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const borrowed = contentSessionClient(pool);
  const run = async (held: ContentSession) => {
    const abort = () => held.dispose(true);
    signal?.addEventListener('abort', abort, { once: true });
    try { return await work(held.client); }
    finally { signal?.removeEventListener('abort', abort); }
  };
  if (borrowed) return run(sessions.getStore()!.get(pool)!);
  const scope = new AsyncResource('content-session');
  return scope.runInAsyncScope(() => sessions.run(new Map(sessions.getStore()), async () => {
    const client = await pool.connect();
    const held: ContentSession = { client, active: true, dispose: failed => {
      if (!held.active) return;
      held.active = false;
      // An abandoned dispatcher can still be unwinding a transaction. Destroy
      // immediately on cancellation, even when its query has not settled.
      client.release(failed);
    } };
    const current = new Map(sessions.getStore());
    current.set(pool, held);
    let failed = false;
    try {
      signal?.throwIfAborted();
      return await sessions.run(current, () => run(held));
    } catch (error) { failed = true; throw error; }
    finally { held.dispose(failed); }
  })).finally(() => scope.emitDestroy());
}
