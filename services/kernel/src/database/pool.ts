import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type Pool, type PoolClient } from 'pg';
import { ConfigError } from '../commerce/config.ts';

export const KERNEL_POOL_MAX = 10;
const DEFAULT_ACQUIRE_TIMEOUT_MILLIS = 200;
const ACQUIRE_TIMEOUT_VARIABLE = 'KERNEL_POOL_ACQUIRE_TIMEOUT_MS';

export function readPoolAcquireTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[ACQUIRE_TIMEOUT_VARIABLE];
  if (value === undefined) return DEFAULT_ACQUIRE_TIMEOUT_MILLIS;
  if (!/^\d+$/.test(value)) throw new ConfigError(ACQUIRE_TIMEOUT_VARIABLE);
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 10_000) {
    throw new ConfigError(ACQUIRE_TIMEOUT_VARIABLE);
  }
  return timeout;
}

export class NestedPoolCheckoutError extends Error {
  constructor() {
    super('A command cannot check out a second connection from the same pool');
    this.name = 'NestedPoolCheckoutError';
  }
}

const heldPools = new AsyncLocalStorage<ReadonlySet<Pool>>();
const brokenClients = new WeakMap<PoolClient, Error>();
type Connect = Pool['connect'];

export function createPool(
  url: string,
  options: { connectionTimeoutMillis?: number; idleTimeoutMillis?: number; min?: number } = {},
): Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: KERNEL_POOL_MAX,
    ...(options.min === undefined ? {} : { min: options.min }),
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? readPoolAcquireTimeoutMillis(),
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    options: '-c idle_in_transaction_session_timeout=5000',
    types: {
      getTypeParser(oid, format) {
        // pg omits name[] (1003); it uses the same wire representation as text[] (1009).
        const nameArray = oid === (1003 as typeof oid) && format !== 'binary';
        return pg.types.getTypeParser(nameArray ? (1009 as typeof oid) : oid, format);
      },
    },
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
