import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { withQueryAccounting } from '../../src/database/pool.ts';
import {
  requireFollowCountHealth,
  withFollowCountReadConnection,
} from '../../src/library/adapters/follow-count-observation.ts';
import { createFollowCountsDriver } from './support/follow-counts-driver.ts';

const location = new URL('./support/follow-counts-driver.ts', import.meta.url);
process.env.FOLLOW_COUNTS_DRIVER = location.href;
await import('../../../../specs/follow-counts-outcomes.test.ts');

test('Follow acceptance binds the native factory by its actual file URL', async () => {
  expect(process.env.FOLLOW_COUNTS_DRIVER).toBe(location.href);
  expect(typeof (await import('./support/follow-counts-driver.ts')).createFollowCountsDriver).toBe('function');
});

test('expired health root, effect-lag and queued reads release capacity for subsequent readers', async () => {
  const driver = await createFollowCountsDriver();
  const pool = new Pool({
    connectionString: driver.world.native.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });
  let held: PoolClient | undefined;
  const read = () => requireFollowCountHealth(pool, Date.now() + 1_000);
  const removed = () => once(pool, 'remove', { signal: AbortSignal.timeout(5_000) });
  try {
    expect((await read()).sampledAt).toBeString();
    for (const fault of ['projection_unready', 'consumer_lag_unavailable'] as const) {
      await driver.fault(fault);
      const released = removed();
      const startedAt = Date.now();
      await expect(requireFollowCountHealth(pool, startedAt + 100)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await released;
      expect(pool.totalCount).toBe(0);
      // Keep the dependency locked: even a blocked server query cannot hold
      // the only checkout needed by a subsequent independent reader.
      expect((await pool.query('SELECT 42 AS answer')).rows).toEqual([{ answer: 42 }]);
      await driver.fault('clear');
      expect((await read()).consumerObservedAt).toBeString();
    }
    held = await pool.connect();
    const client = held;
    const query = client.query;
    let dispatched = 0;
    held.query = ((...args: unknown[]) => {
      dispatched++;
      return Reflect.apply(query, client, args);
    }) as PoolClient['query'];
    const released = removed();
    const startedAt = Date.now();
    await expect(requireFollowCountHealth(pool, startedAt + 100)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    held.release();
    held = undefined;
    await released;
    expect(dispatched).toBe(0);
    expect(pool.waitingCount).toBe(0);
    expect((await read()).sampledAt).toBeString();
  } finally {
    held?.release();
    try {
      await driver.fault('clear');
    } finally {
      try {
        await pool.end();
      } finally {
        await driver.close();
      }
    }
  }
});

test('borrowed total and outgoing reads discard blocked IO and late checkouts without losing work accounting', async () => {
  const driver = await createFollowCountsDriver();
  const pool = new Pool({
    connectionString: driver.world.native.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });
  let held: PoolClient | undefined;
  const removed = () => once(pool, 'remove', { signal: AbortSignal.timeout(5_000) });
  const read = (deadline: number) =>
    withFollowCountReadConnection(pool, deadline, async (tx) => (await tx.query('SELECT 42 AS answer')).rows);
  try {
    for (const [fault, statement] of [
      ['total_unavailable', 'SELECT total FROM library.follow_count_total LIMIT 1'],
      ['outgoing_unavailable', 'SELECT observed_live_count FROM library.follow_count_owner LIMIT 1'],
    ] as const) {
      await driver.fault(fault);
      const cost = { connections: 0, queries: 0 };
      const released = removed();
      const startedAt = Date.now();
      await expect(
        withQueryAccounting(
          {
            connection(dispatch) {
              cost.connections++;
              return dispatch();
            },
            query(_sql, _operands, dispatch) {
              cost.queries++;
              return dispatch();
            },
          },
          () =>
            withFollowCountReadConnection(pool, startedAt + 100, async (tx) => {
              await tx.query('SELECT 1');
              await tx.query(statement);
              // Expiry must stop a multi-query callback before its next SQL.
              await tx.query('SELECT 2');
            }),
        ),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await released;
      expect(cost).toEqual({ connections: 1, queries: 2 });
      expect(pool.totalCount).toBe(0);
      // The server-side table lock is still held when the next reader succeeds.
      expect(await read(Date.now() + 1_000)).toEqual([{ answer: 42 }]);
      await driver.fault('clear');
    }
    held = await pool.connect();
    const client = held;
    const query = client.query;
    let dispatched = 0;
    client.query = ((...args: unknown[]) => {
      dispatched++;
      return Reflect.apply(query, client, args);
    }) as PoolClient['query'];
    const released = removed();
    await expect(read(Date.now() + 100)).rejects.toThrow();
    held.release();
    held = undefined;
    await released;
    expect(dispatched).toBe(0);
    expect(pool.waitingCount).toBe(0);
    expect(await read(Date.now() + 1_000)).toEqual([{ answer: 42 }]);
  } finally {
    held?.release();
    try {
      await driver.fault('clear');
    } finally {
      try {
        await pool.end();
      } finally {
        await driver.close();
      }
    }
  }
});
