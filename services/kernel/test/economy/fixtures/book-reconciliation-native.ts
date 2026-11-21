import type { Pool, PoolClient } from 'pg';
import {
  withBoundedReadLifetime,
  type BoundedReadLifetimeOptions,
} from '../../../src/database/bounded-read-lifetime.ts';

/** Use the native lifetime in the disposable Economy-only database without unrelated Kernel composition. */
export function bookFixtureDatabase(pool: Pool) {
  function bounded<T>(
    deadline: number,
    work: (client: PoolClient) => Promise<T>,
    options: BoundedReadLifetimeOptions = {},
  ) {
    let discarded: PoolClient | undefined;
    return withBoundedReadLifetime(
      async (read) => {
        const client = await pool.connect();
        try {
          return await read(client);
        } finally {
          if (discarded !== client) client.release();
        }
      },
      (client, error) => {
        discarded = client;
        client.release(error);
      },
      deadline,
      work,
      options,
    );
  }
  return {
    snapshot: <T>(deadline: number, work: (client: PoolClient) => Promise<T>) =>
      bounded(deadline, work, { transaction: 'repeatable-read-read-only' }),
    transaction: <T>(work: (client: PoolClient) => Promise<T>) =>
      bounded(
        Date.now() + 5000,
        async (client) => {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        },
        { mode: 'command' },
      ),
    read: <T>(work: (client: PoolClient) => Promise<T>) => bounded(Date.now() + 5000, work),
  };
}
