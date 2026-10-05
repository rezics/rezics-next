import { Pool, type PoolConfig } from 'pg';

/**
 * Session defaults for every request-serving PostgreSQL pool. Request paths
 * that need less set `SET LOCAL lock_timeout = '2s'` and a 5 s statement
 * timeout; these catch the paths that set nothing.
 *
 * - Lock waits sit above the 2 s request bound and below the 8 s the refresh
 *   token guard and 15 s the Content rebuild fence set for themselves.
 * - A transaction may idle while it awaits one Fuseki command (10 s deadline,
 *   12 s fetch) or catalogue batch (35 s fetch), or an Account provider
 *   exchange under its advisory lock; one minute covers the longest.
 * - No request-pool transaction legitimately runs for minutes: statement
 *   timeouts are at most 60 s. Restore, rebuild, migration and capture jobs
 *   open their own connections.
 */
export interface ConnectionBounds {
  lockTimeout: string;
  idleInTransactionSessionTimeout: string;
  transactionTimeout: string;
}

export const CONNECTION_BOUNDS: ConnectionBounds = {
  lockTimeout: '5s',
  idleInTransactionSessionTimeout: '60s',
  transactionTimeout: '5min',
};

/** Startup options carrying the bounds, followed by any caller options. */
export function connectionBoundOptions(extra?: string, bounds: ConnectionBounds = CONNECTION_BOUNDS): string {
  return [`-c lock_timeout=${bounds.lockTimeout}`,
    `-c idle_in_transaction_session_timeout=${bounds.idleInTransactionSessionTimeout}`,
    `-c transaction_timeout=${bounds.transactionTimeout}`,
    ...(extra ? [extra] : [])].join(' ');
}

/**
 * A pool whose connections carry the bounds. The server ends a connection that
 * outlives them, and pg-pool drops its own error listener while a client is
 * checked out, so an idle-in-transaction kill would surface as an unhandled
 * client error and take the process down; keep one listener per client.
 */
export function boundedPool(config: PoolConfig, bounds: ConnectionBounds = CONNECTION_BOUNDS): Pool {
  const pool = new Pool({ ...config, options: connectionBoundOptions(config.options, bounds) });
  const failed = (error: Error) => console.error('Database connection failed:', error.message);
  pool.on('error', failed);
  pool.on('connect', client => { client.on('error', failed); });
  return pool;
}
