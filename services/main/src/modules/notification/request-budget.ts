import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { fusekiReadBudget, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  type FusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { GraphReadFence, graphReadVersion } from '../../infrastructure/graph-read-fence.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { NotificationUnavailable } from './store.ts';

/** The complete notification read, including Account and the final disclosure
 * fence, uses the existing interactive read allocation. Never renew it per item. */
export const NOTIFICATION_READ_COST = {
  graphCalls: WORK_READ_COST.graphCalls,
  graphBytes: WORK_READ_COST.graphBytes,
  deadlineMs: WORK_READ_COST.deadlineMs,
} as const;

const allocation = new AsyncLocalStorage<AbortSignal>();

export function checkNotificationRead(): void { allocation.getStore()?.throwIfAborted(); }

/** Also fences adapters that swallow an abort as an optional-field failure. */
export async function notificationReadStep<T>(read: () => Promise<T>): Promise<T> {
  checkNotificationRead();
  const signal = allocation.getStore();
  const pending = read();
  // Owners with their own finite timeout (such as shared signing-key refresh)
  // may drain, but cannot hold up this response or start its next step.
  const result = await (signal ? new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  }) : pending);
  checkNotificationRead();
  return result;
}

export async function notificationRead<T>(request: Request | undefined,
  read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const current = allocation.getStore();
  if (current) return notificationReadStep(() => read(current));
  const outer = fusekiReadBudget.getStore();
  const lifetime = new AbortController();
  const deadline = Math.min(performance.now() + NOTIFICATION_READ_COST.deadlineMs, outer?.deadline ?? Infinity);
  const timer = setTimeout(() => lifetime.abort(new Error('Notification read deadline exceeded')),
    Math.max(0, deadline - performance.now()));
  timer.unref();
  const signal = AbortSignal.any([lifetime.signal, ...request ? [request.signal] : [],
    ...outer ? [outer.signal] : []]);
  let callsLeft: number = NOTIFICATION_READ_COST.graphCalls;
  let bytesLeft: number = NOTIFICATION_READ_COST.graphBytes;
  const budget: FusekiReadBudget = { signal,
    deadline, diagnostics: outer?.diagnostics,
    get callsLeft() { return Math.min(callsLeft, outer?.callsLeft ?? callsLeft); },
    set callsLeft(value: number) { const used = this.callsLeft - value; callsLeft -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytesLeft, outer?.bytesLeft ?? bytesLeft); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytesLeft -= used; if (outer) outer.bytesLeft -= used; },
  };
  try {
    return await allocation.run(signal, () => fusekiReadBudget.run(budget,
      () => notificationReadStep(() => read(signal))));
  } catch (error) {
    if (signal.aborted || error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge) {
      throw new NotificationUnavailable('Notification read allocation exceeded or cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // A deferred continuation cannot spend the completed request's allocation.
    lifetime.abort();
  }
}

/** Repeated graph inputs may be retained only inside one read with matching
 * live native versions. SQL, Content and recipient decisions always run again.
 * A moved graph retries the whole read within the same allocation. */
export async function notificationGraphRead<T>(environment: WorkActivationEnvironment | undefined,
  read: () => Promise<T>): Promise<T> {
  if (!environment) return notificationReadStep(read);
  const { fuseki, lineage } = environment;
  const position = () => new GraphReadFence(fuseki).capture(async () => {
    const result = await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      } } LIMIT 2`, 4096);
    const rows = result.results?.bindings ?? [];
    const sequence = rows[0]?.sequence?.value;
    if (rows.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(sequence ?? '')) {
      throw new NotificationUnavailable('Notification graph is unavailable');
    }
    return { sequence, version: graphReadVersion(result) };
  });
  for (let attempt = 0; attempt < WORK_READ_COST.attempts; attempt++) {
    const before = await notificationReadStep(position);
    const fence = new GraphReadFence(fuseki);
    const result = await notificationReadStep(() => before.version ? fence.verify(read) : read());
    const after = await notificationReadStep(position);
    if (before.sequence === after.sequence && before.version === after.version) return result;
  }
  throw new NotificationUnavailable('Notification graph changed during the read');
}

const pools = new WeakMap<Pool, Pool>();

/** Composition gives every owner the same pool identity. Outside a notification
 * allocation this is a transparent adapter. During a read every SQL boundary
 * checks cancellation; cancelling an in-flight statement retires its checkout. */
export function notificationReadPool(pool: Pool): Pool {
  const existing = pools.get(pool);
  if (existing) return existing;
  const connect = async (): Promise<PoolClient> => {
    checkNotificationRead();
    const client = await pool.connect();
    if (allocation.getStore()?.aborted) {
      client.release(true);
      checkNotificationRead();
    }
    let released = false;
    const release = (error?: Error | boolean) => {
      if (!released) { released = true; client.release(error); }
    };
    return new Proxy(client, { get(target, property) {
      if (property === 'release') return release;
      if (property === 'query') return async (...args: Parameters<PoolClient['query']>) => {
        // Rollback is cleanup, never a new subject read. A retired connection
        // has already rolled back at the server when its socket was closed.
        if (args[0] === 'ROLLBACK') return released ? undefined : target.query(...args);
        const signal = allocation.getStore();
        signal?.throwIfAborted();
        if (released) throw new Error('Notification SQL checkout is released');
        const abort = () => release(true);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const result = await target.query(...args);
          signal?.throwIfAborted();
          return result;
        } finally { signal?.removeEventListener('abort', abort); }
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const guarded = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return (...args: unknown[]) => allocation.getStore() && !args.length
      ? connect() : Reflect.apply(target.connect, target, args);
    if (property === 'query') return (...args: unknown[]) => {
      if (!allocation.getStore()) return Reflect.apply(target.query, target, args);
      return (async () => {
        const client = await connect();
        try { return await Reflect.apply(client.query, client, args); }
        catch (error) { client.release(error instanceof Error ? error : true); throw error; }
        finally { client.release(); }
      })();
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  pools.set(pool, guarded);
  pools.set(guarded, guarded);
  return guarded;
}
