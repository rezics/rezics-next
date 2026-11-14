import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { admitPrivateFollowRead } from '../../src/library/follow-read-admission.ts';
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

test('private Follow admission bounds owner and home locks and discards expired checkouts', async () => {
  const driver = await createFollowCountsDriver();
  const pool = new Pool({
    connectionString: driver.world.native.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });
  const owner = await driver.world.native.accountActor('owner');
  let held: PoolClient | undefined;
  const removed = () => once(pool, 'remove', { signal: AbortSignal.timeout(5_000) });
  const observe = (startedAt: number, expected?: Awaited<ReturnType<typeof admitPrivateFollowRead>>) => {
    const cost = { connections: 0, queries: [] as string[] };
    const run = () => admitPrivateFollowRead(pool, owner, startedAt + 100, expected);
    return {
      cost,
      run: () =>
        withQueryAccounting(
          {
            connection(dispatch) {
              cost.connections++;
              return dispatch();
            },
            query(sql, _operands, dispatch) {
              cost.queries.push(sql);
              return dispatch();
            },
          },
          run,
        ),
    };
  };
  try {
    const initial = await admitPrivateFollowRead(pool, owner, Date.now() + 2_000);
    expect(await admitPrivateFollowRead(pool, owner, Date.now() + 2_000, initial)).toEqual(initial);

    for (const fault of ['owner_admission_unavailable', 'home_admission_unavailable'] as const) {
      await driver.fault(fault);
      const observed = observe(Date.now(), initial);
      const released = removed();
      const startedAt = Date.now();
      await expect(observed.run()).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await released;
      expect(observed.cost.connections).toBe(1);
      expect(observed.cost.queries).not.toContain('ROLLBACK');
      expect(pool.totalCount).toBe(0);
      await driver.fault('clear');
      expect(await admitPrivateFollowRead(pool, owner, Date.now() + 2_000, initial)).toEqual(initial);
    }

    held = await pool.connect();
    const client = held;
    const query = client.query;
    let dispatched = 0;
    held.query = ((...args: unknown[]) => {
      dispatched++;
      return Reflect.apply(query, client, args);
    }) as PoolClient['query'];
    const observed = observe(Date.now());
    const released = removed();
    const startedAt = Date.now();
    await expect(observed.run()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    held.release();
    held = undefined;
    await released;
    expect(dispatched).toBe(0);
    expect(observed.cost).toEqual({ connections: 1, queries: [] });
    expect(pool.waitingCount).toBe(0);
    expect(await admitPrivateFollowRead(pool, owner, Date.now() + 2_000, initial)).toEqual(initial);
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

test('expired health, total, outgoing and queued reads release capacity and retain work accounting', async () => {
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
  const blockedCountRead = (statement: string) => (deadline: number) =>
    withFollowCountReadConnection(pool, deadline, async (tx) => {
      await tx.query(statement);
      // Expiry must stop a multi-query callback before its next SQL.
      return tx.query('SELECT 42 AS answer');
    });
  try {
    expect((await read()).sampledAt).toBeString();
    for (const [fault, observe, queries] of [
      ['projection_unready', (deadline: number) => requireFollowCountHealth(pool, deadline), 1],
      ['consumer_lag_unavailable', (deadline: number) => requireFollowCountHealth(pool, deadline), 2],
      ['total_unavailable', blockedCountRead('SELECT total FROM library.follow_count_total LIMIT 1'), 1],
      [
        'outgoing_unavailable',
        blockedCountRead('SELECT observed_live_count FROM library.follow_count_owner LIMIT 1'),
        1,
      ],
    ] as const) {
      await driver.fault(fault);
      const cost = { connections: 0, queries: 0 };
      const released = removed();
      const startedAt = Date.now();
      await expect(
        withQueryAccounting<unknown>(
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
          () => observe(startedAt + 100),
        ),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await released;
      expect(cost).toEqual({ connections: 1, queries });
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
