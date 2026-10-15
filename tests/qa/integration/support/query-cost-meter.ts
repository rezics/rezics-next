import type { FusekiClient } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { isRetainedGraphQuery } from '../../../../services/main/src/infrastructure/graph-read-fence.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import type { WorkProfile } from '../../support/work-profile.ts';
import { commandCounters } from '../../../../packages/observability/src/http-measurement.ts';
import { foregroundCounted } from './operation-cost.ts';

export { foregroundCounted } from './operation-cost.ts';

/** Keep SQL issued by a checkout callback in its caller's counting context. */
export function attributeSqlCheckoutCallers(): () => void {
  const prototype = Pool.prototype as unknown as { connect: (...args: unknown[]) => unknown };
  const originalConnect = prototype.connect;
  prototype.connect = function (this: unknown, ...args: unknown[]) {
    const callback = args[0];
    if (typeof callback !== 'function') return originalConnect.apply(this, args);
    // A waiting caller can receive an idle client from a background release.
    const resume = AsyncLocalStorage.snapshot();
    return originalConnect.call(this, function (this: unknown, ...values: unknown[]) {
      return resume(() => callback.apply(this, values));
    });
  };
  return () => { prototype.connect = originalConnect; };
}

/** Actual native work, including rejected candidates. Missing evidence stays unknown. */
export function nativeCounter(profile: WorkProfile, name: typeof commandCounters[number]): number | null {
  const values = profile.fusekiCalls.map(call => call.nativeWork?.[name]);
  return values.some(value => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

/** Call count and JSON byte size of results the caller itself issued. */
export type QueryMeter = {
  queries: number;
  bytes: number;
  reset(): void;
};

function meterState(): QueryMeter {
  const state: QueryMeter = {
    queries: 0,
    bytes: 0,
    reset() {
      state.queries = 0;
      state.bytes = 0;
    },
  };
  return state;
}

function record(state: QueryMeter, value: unknown): void {
  state.queries++;
  const text = JSON.stringify(value);
  if (text !== undefined) state.bytes += Buffer.byteLength(text);
}

function countedQuery<Args extends unknown[]>(
  state: QueryMeter,
  query: (...args: Args) => Promise<unknown>,
): (...args: Args) => Promise<unknown> {
  return async (...args: Args) => {
    // Attribute the caller, not a tick the round trip happens to overlap.
    const counted = foregroundCounted();
    const result = await query(...args);
    if (counted) record(state, result);
    return result;
  };
}

/** Proxy whose `query` counts only `foregroundCounted()` reads. Other methods stay on the client. */
export function meterFuseki<T extends FusekiClient>(client: T): T & QueryMeter {
  const state = meterState();
  const query = client.query.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === 'queries') return state.queries;
      if (property === 'bytes') return state.bytes;
      if (property === 'reset') return state.reset.bind(state);
      if (property === 'query') return ((...args: Parameters<FusekiClient['query']>) =>
        isRetainedGraphQuery(client, ...args) ? query(...args) : countedQuery(state, query)(...args)) as T['query'];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & QueryMeter;
}

function meterClient(client: PoolClient, state: QueryMeter): PoolClient {
  const query = client.query.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query') return countedQuery(state, query as (...args: unknown[]) => Promise<unknown>);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Proxy whose pool and checkout `query` calls share one foreground meter. */
export function meterPool<T extends Pool>(pool: T): T & QueryMeter {
  const state = meterState();
  const query = pool.query.bind(pool);
  const connect = pool.connect.bind(pool);
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'queries') return state.queries;
      if (property === 'bytes') return state.bytes;
      if (property === 'reset') return state.reset.bind(state);
      if (property === 'query') return countedQuery(state, query as (...args: unknown[]) => Promise<unknown>);
      if (property === 'connect') return (...args: unknown[]) => {
        if (typeof args[0] === 'function') return connect(...args as Parameters<Pool['connect']>);
        return (connect as unknown as (...rest: unknown[]) => Promise<PoolClient>)(...args)
          .then(client => meterClient(client, state));
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & QueryMeter;
}
