import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import {
  withManagementReadConnection,
  withManagementReadSnapshot,
} from '../../src/community/management-read-connection.ts';

function fakeConnection(run: (sql: string) => Promise<unknown>) {
  const statements: string[] = [];
  let signalRelease!: () => void;
  let releasedError: Error | undefined;
  const released = new Promise<void>((resolve) => (signalRelease = resolve));
  const client = {
    query(query: QueryConfig | string) {
      const sql = typeof query === 'string' ? query : query.text ?? '';
      statements.push(sql);
      return run(sql);
    },
    release(error?: Error) {
      releasedError = error;
      signalRelease();
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return {
    client: client as unknown as PoolClient,
    pool,
    released,
    statements,
    releasedError: () => releasedError,
  };
}

test('a checkout arriving after expiry sends no SQL and releases the late client', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const fake = fakeConnection(async () => ({ rows: [] }));
  const pool = { connect: () => checkout } as unknown as Pool;
  const pending = withManagementReadConnection(pool, Date.now() + 30, (client) => client.query('SELECT late'));

  await expect(pending).rejects.toThrow();
  resolveCheckout(fake.client);
  await fake.released;

  expect(fake.statements).toEqual([]);
  expect(fake.releasedError()).toBeUndefined();
});

test('a successful source read keeps repeatable-read isolation and commits before release', async () => {
  const fake = fakeConnection(async () => ({ rows: [] }));

  await withManagementReadSnapshot(fake.pool, Date.now() + 1_000, (client) => client.query('SELECT source'));
  await fake.released;

  expect(fake.statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT source',
    'COMMIT',
  ]);
  expect(fake.releasedError()).toBeUndefined();
});

for (const blocked of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'SELECT source',
  'COMMIT',
]) {
  test(`a blocked ${blocked} read discards its client without queuing rollback`, async () => {
    const fake = fakeConnection((sql) =>
      sql === blocked ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
    );
    const pending = withManagementReadSnapshot(fake.pool, Date.now() + 50, async (client) => {
      await client.query('SELECT source');
    });

    await expect(pending).rejects.toThrow();
    await fake.released;

    expect(fake.statements).toEqual(
      blocked === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        ? [blocked]
        : blocked === 'SELECT source'
          ? ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', blocked]
          : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', blocked],
    );
    expect(fake.releasedError()).toBeInstanceOf(Error);
  });
}

test('a read failure remains primary when rollback does not finish before the deadline', async () => {
  const primary = new Error('source read failed');
  const fake = fakeConnection(async (sql) => {
    if (sql === 'SELECT source') throw primary;
    if (sql === 'ROLLBACK') return new Promise<never>(() => {});
    return { rows: [] };
  });

  await expect(
    withManagementReadSnapshot(fake.pool, Date.now() + 80, async (client) => {
      await client.query('SELECT source');
    }),
  ).rejects.toBe(primary);
  await fake.released;

  expect(fake.statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT source',
    'ROLLBACK',
  ]);
  expect(fake.releasedError()).toBeInstanceOf(Error);
});
