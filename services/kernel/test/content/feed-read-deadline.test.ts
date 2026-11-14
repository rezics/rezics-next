import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withFeedReadConnection } from '../../src/content/feed-read-connection.ts';
import type { FeedReadClient } from '../../src/content/feed-read-connection.ts';

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [{ value: 'current source' }] })) {
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

const read = async (client: FeedReadClient) => {
  const result = await client.query<{ value: string }>('SELECT source');
  return result.rows[0]?.value;
};

test('feed snapshots retain the repeatable-read transaction and return the committed source', async () => {
  const current = connection();
  await expect(withFeedReadConnection(poolFor(current), Date.now() + 1000, read)).resolves.toBe('current source');
  expect(current.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', 'COMMIT']);
  expect(current.releaseError()).toBeUndefined();
});

for (const blocked of ['BEGIN', 'SELECT source', 'COMMIT']) {
  test(`expiry during ${blocked} discards the client and leaves the next read current`, async () => {
    const stalled = connection((sql) =>
      sql.startsWith(blocked) ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
    );
    const retry = connection();
    const pool = poolFor(stalled, retry);
    await expect(withFeedReadConnection(pool, Date.now() + 100, read)).rejects.toBeInstanceOf(AccessUnavailableError);
    await stalled.releaseWait;
    expect(stalled.statements).not.toContain('ROLLBACK');
    expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);

    await expect(withFeedReadConnection(pool, Date.now() + 1000, read)).resolves.toBe('current source');
    expect(retry.statements.at(-1)).toBe('COMMIT');
  });
}

test('a checkout arriving after expiry sends no SQL and is discarded', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const pool = { connect: () => checkout } as unknown as Pool;
  const attempt = withFeedReadConnection(pool, Date.now() + 100, read);

  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeInstanceOf(AccessUnavailableError);
});

test('a bounded rollback keeps the original source error', async () => {
  const original = new Error('feed source read failed');
  const stalled = connection((sql) =>
    sql === 'ROLLBACK' ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
  );

  await expect(
    withFeedReadConnection(poolFor(stalled), Date.now() + 100, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await stalled.releaseWait;
  expect(stalled.statements.at(-1)).toBe('ROLLBACK');
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});
