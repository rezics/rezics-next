import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withNoticeInboxReadConnection } from '../../src/content/notice-inbox-read-connection.ts';
import type { AccessClient } from '../../src/request/access.ts';

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let released!: () => void;
  const releaseWait = new Promise<void>((resolve) => (released = resolve));
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released();
    },
  } as unknown as PoolClient;
  return { client, statements, releaseWait, releaseError: () => releaseError };
}

type Connection = ReturnType<typeof connection>;

function poolFor(...clients: Connection[]): Pool {
  let index = 0;
  return {
    connect: async () => {
      const next = clients[index++];
      if (!next) throw new Error('Fake pool ran out of clients');
      return next.client;
    },
  } as unknown as Pool;
}

const read = (client: AccessClient) => client.query('SELECT source').then(() => 'current source');
const snapshot = (pool: Pool, deadline: number) =>
  withNoticeInboxReadConnection(pool, deadline, read, { repeatableRead: true });

test('summary read snapshots keep repeatable-read commit controls', async () => {
  const current = connection();
  await expect(snapshot(poolFor(current), Date.now() + 1000)).resolves.toBe('current source');
  expect(current.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', 'COMMIT']);
  expect(current.releaseError()).toBeUndefined();
});

for (const blocked of ['BEGIN', 'SELECT source', 'COMMIT']) {
  test(`a deadline during ${blocked} discards its client and permits the next read`, async () => {
    const stalled = connection((sql) =>
      sql.startsWith(blocked) ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
    );
    const retry = connection();
    const pool = poolFor(stalled, retry);
    await expect(snapshot(pool, Date.now() + 100)).rejects.toBeInstanceOf(AccessUnavailableError);
    await stalled.releaseWait;
    expect(stalled.statements).not.toContain('ROLLBACK');
    expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
    await expect(snapshot(pool, Date.now() + 1000)).resolves.toBe('current source');
    expect(retry.statements.at(-1)).toBe('COMMIT');
  });
}

test('a checkout arriving after expiry issues no SQL and the next visit succeeds', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const late = connection();
  const retry = connection();
  let index = 0;
  const pool = {
    connect: () => (index++ === 0 ? checkout : Promise.resolve(retry.client)),
  } as unknown as Pool;
  await expect(snapshot(pool, Date.now() + 100)).rejects.toBeInstanceOf(AccessUnavailableError);
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeInstanceOf(AccessUnavailableError);
  await expect(snapshot(pool, Date.now() + 1000)).resolves.toBe('current source');
});

test('a settled read failure rolls back and preserves its original error', async () => {
  const current = connection();
  const original = new Error('notice source failed');
  await expect(
    withNoticeInboxReadConnection(
      poolFor(current),
      Date.now() + 1000,
      async () => {
        throw original;
      },
      { repeatableRead: true },
    ),
  ).rejects.toBe(original);
  expect(current.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(current.releaseError()).toBeUndefined();
});
