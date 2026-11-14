import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { ProblemError } from '../../src/http/problem-error.ts';
import { withReadingDashboardReadConnection } from '../../src/library/reading-dashboard-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let onRelease!: () => void;
  const released = new Promise<void>((resolve) => (onRelease = resolve));
  const client = {
    query(input: QueryConfig | string) {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    },
    release(error?: Error) {
      releaseError = error;
      onRelease();
    },
  } as unknown as PoolClient;
  return { client, statements, released, releaseError: () => releaseError };
}

function pool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a checkout that arrives after expiry sends no SQL', async () => {
  const checkout = deferred<PoolClient>();
  const late = connection();
  const read = withReadingDashboardReadConnection(
    pool(() => checkout.promise),
    { deadline: Date.now() + 50 },
    async (client) => client.query('BEGIN'),
  );

  await expect(read).rejects.toBeInstanceOf(Error);
  checkout.resolve(late.client);
  await late.released;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeUndefined();
}, 10_000);

for (const phase of ['BEGIN', 'SELECT pending', 'COMMIT'])
  test(`an unsettled ${phase} discards its connection without queued rollback`, async () => {
    const pending = deferred<unknown>();
    const held = connection((sql) => (sql === phase ? pending.promise : Promise.resolve({ rows: [] })));
    const next = connection();
    const clients = [held.client, next.client];
    const sharedPool = pool(async () => clients.shift()!);
    const read = withReadingDashboardReadConnection(
      sharedPool,
      { deadline: Date.now() + 100 },
      async (client) => {
        if (phase !== 'BEGIN') await client.query('BEGIN');
        await client.query(phase);
      },
    );

    await expect(read).rejects.toBeInstanceOf(Error);
    await held.released;
    expect(held.statements).toContain(phase);
    expect(held.statements.some((sql) => /^ROLLBACK\b/.test(sql))).toBe(false);
    expect(held.releaseError()).toBeInstanceOf(Error);
    pending.resolve({ rows: [] });

    const value = await withReadingDashboardReadConnection(
      sharedPool,
      { deadline: Date.now() + 1000 },
      async (client) => {
        await client.query('BEGIN');
        await client.query('COMMIT');
        return 'next-read';
      },
    );
    expect(value).toBe('next-read');
    expect(next.statements).toEqual(['BEGIN', 'COMMIT']);
    expect(next.releaseError()).toBeUndefined();
  }, 10_000);

test('a known optional-schema failure keeps its savepoint fallback and commits cleanly', async () => {
  const missing = Object.assign(new Error('optional relation missing'), { code: '42P01' });
  const client = connection(async (sql) => {
    if (sql === 'SELECT optional schema') throw missing;
    return { rows: [] };
  });
  const installed = await withReadingDashboardReadConnection(
    pool(async () => client.client),
    { deadline: Date.now() + 1000 },
    async (query) => {
      await query.query('BEGIN');
      await query.query('SAVEPOINT reader_schema');
      let available = true;
      try {
        await query.query('SELECT optional schema');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== '42P01') throw error;
        await query.query('ROLLBACK TO SAVEPOINT reader_schema');
        available = false;
      }
      await query.query('COMMIT');
      return available;
    },
  );

  expect(installed).toBe(false);
  expect(client.statements).toEqual([
    'BEGIN',
    'SAVEPOINT reader_schema',
    'SELECT optional schema',
    'ROLLBACK TO SAVEPOINT reader_schema',
    'COMMIT',
  ]);
  expect(client.releaseError()).toBeUndefined();
});

test('cleanup timeout preserves the primary error and discards its connection', async () => {
  const cleanup = deferred<unknown>();
  const client = connection((sql) => (sql === 'ROLLBACK' ? cleanup.promise : Promise.resolve({ rows: [] })));
  const primary = new ProblemError('forbidden');
  const read = withReadingDashboardReadConnection(
    pool(async () => client.client),
    { deadline: Date.now() + 120 },
    async (query) => {
      await query.query('BEGIN');
      throw primary;
    },
  );

  await expect(read).rejects.toBe(primary);
  await client.released;
  expect(client.statements).toEqual(['BEGIN', 'ROLLBACK']);
  expect(client.releaseError()).toBeInstanceOf(Error);
  cleanup.resolve({ rows: [] });
}, 10_000);

test('an error after successful commit never rolls the completed transaction back', async () => {
  const client = connection();
  const primary = new ProblemError('dependency_unavailable');
  const read = withReadingDashboardReadConnection(
    pool(async () => client.client),
    { deadline: Date.now() + 1000 },
    async (query) => {
      await query.query('BEGIN');
      await query.query('COMMIT');
      throw primary;
    },
  );

  await expect(read).rejects.toBe(primary);
  expect(client.statements).toEqual(['BEGIN', 'COMMIT']);
  expect(client.releaseError()).toBeUndefined();
});
