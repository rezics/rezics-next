import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

const measurements = new AsyncLocalStorage<readonly { statements: number }[]>();
const observedClients = new WeakSet<object>();
const observedPools = new WeakSet<object>();
let forwardingQuery = 0;

/** Observe actual driver invocations, including transaction and isolation SQL.
 * Wrappers preserve every pg overload. Synchronous forwarding through a proxy
 * is counted once; concurrent operations carry independent async counters. */
export function observeStatementClient(client: Pick<PoolClient, 'query'>): void {
  // Dynamic query proxies forward to the observed driver; replacing their
  // backing method could make that forwarding recursive.
  if (observedClients.has(client) || client.query !== client.query) return;
  observedClients.add(client);
  const query = client.query;
  const inherited = !Object.hasOwn(client, 'query');
  client.query = function (this: Pick<PoolClient, 'query'>, ...args: unknown[]) {
    if (!forwardingQuery) for (const counter of measurements.getStore() ?? []) counter.statements++;
    forwardingQuery++;
    // A driver hook may decorate the prototype after a pool client was first
    // observed. Preserve normal prototype dispatch instead of pinning the old
    // method and silently bypassing later telemetry or diagnostic observers.
    try { return Reflect.apply(inherited ? Object.getPrototypeOf(this).query : query, this, args); }
    finally { forwardingQuery--; }
  } as PoolClient['query'];
}

/** Attach before lending either a callback or promise checkout, including
 * clients already in the pool when observation is first configured. */
export function observeStatementPool(pool: Pool): void {
  if (observedPools.has(pool) || pool.connect !== pool.connect) return;
  observedPools.add(pool);
  if (typeof pool.connect !== 'function') { observeStatementClient(pool); return; }
  const connect = pool.connect;
  pool.connect = function (this: Pool, ...args: unknown[]) {
    const callback = args[0];
    const counters = measurements.getStore();
    if (typeof callback === 'function') {
      const callbackConnect = connect as (this: Pool, ready: (error: Error | undefined, client: PoolClient | undefined,
        release: unknown) => void) => void;
      return callbackConnect.call(this,
      (error: Error | undefined, client: PoolClient | undefined, release: unknown): void => {
        if (client) observeStatementClient(client);
        // Idle-client queues may deliver in the releasing caller's async
        // context. Attribute SQL to the scope that requested this checkout.
        measurements.run(counters ?? [], () => callback(error, client, release));
      },
      );
    }
    return (Reflect.apply(connect, this, args) as Promise<PoolClient>).then(client => {
      observeStatementClient(client);
      return client;
    });
  } as Pool['connect'];
}

export async function measureStatements<T>(run: () => Promise<T>, client?: PoolClient) {
  if (client && ('connection' in client || !('connect' in client))) observeStatementClient(client);
  const counter = { statements: 0 };
  const result = await measurements.run([...(measurements.getStore() ?? []), counter], run);
  return { result, statements: counter.statements };
}
