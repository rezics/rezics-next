import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type Pool, type PoolClient } from 'pg';

export class NestedPoolCheckoutError extends Error {
  constructor() {
    super('A command cannot check out a second connection from the same pool');
    this.name = 'NestedPoolCheckoutError';
  }
}

const heldPools = new AsyncLocalStorage<ReadonlySet<Pool>>();
const brokenClients = new WeakMap<PoolClient, Error>();
type Connect = Pool['connect'];

export function createPool(url: string): Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 200,
    idleTimeoutMillis: 30_000,
    options: '-c idle_in_transaction_session_timeout=5000',
  });
  pool.on('error', () => {});
  pool.on('connect', (client) => client.on('error', () => {}));

  const connect = pool.connect.bind(pool) as Connect;
  (pool as Pool & { connect: Connect }).connect = ((callback?: Parameters<Connect>[0]) => {
    if (heldPools.getStore()?.has(pool)) {
      const error = new NestedPoolCheckoutError();
      if (callback) {
        queueMicrotask(() => callback(error, undefined as never, undefined as never));
        return undefined as never;
      }
      return Promise.reject(error) as never;
    }
    return callback ? connect(callback) : connect();
  }) as Connect;
  return pool;
}

export async function withConnection<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const parent = heldPools.getStore();
  const next = new Set(parent);
  next.add(pool);
  try {
    return await heldPools.run(next, () => work(client));
  } finally {
    client.release(brokenClients.get(client));
  }
}

export function discardConnection(client: PoolClient, error: Error): void {
  brokenClients.set(client, error);
}
