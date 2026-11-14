import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import {
  withSourceRatingReadConnection,
  type SourceRatingReadClient,
} from '../../src/rating/source-rating-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [{ value: 'current' }] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let released!: () => void;
  const releaseWait = new Promise<void>((resolve) => (released = resolve));
  const client = {
    query(input: string | { text: string }) {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    },
    release(error?: Error) {
      releaseError = error;
      released();
    },
  } as unknown as PoolClient;
  return { client, statements, releaseWait, releaseError: () => releaseError };
}

function poolFor(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

async function read(client: SourceRatingReadClient) {
  const result = await client.query<{ value: string }>('SELECT source');
  return result.rows[0]?.value;
}

test('source reads keep repeatable-read snapshots and return successful results', async () => {
  const snapshot = connection();
  await expect(
    withSourceRatingReadConnection(
      poolFor(async () => snapshot.client),
      Date.now() + 1_000,
      read,
      {
        repeatableRead: true,
      },
    ),
  ).resolves.toBe('current');
  expect(snapshot.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', 'COMMIT']);
  expect(snapshot.releaseError()).toBeUndefined();
});

for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', 'COMMIT']) {
  test(`expiry during ${blocked} discards the client and the next read succeeds`, async () => {
    const pending = deferred<unknown>();
    const stalled = connection((sql) => (sql === blocked ? pending.promise : Promise.resolve({ rows: [] })));
    const next = connection();
    let checkout = 0;
    const pool = poolFor(async () => (checkout++ === 0 ? stalled.client : next.client));
    const body = blocked === 'SELECT source' ? read : async () => 'current';
    await expect(
      withSourceRatingReadConnection(pool, Date.now() + 100, body, { repeatableRead: true }),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
    await stalled.releaseWait;
    expect(stalled.statements).not.toContain('ROLLBACK');
    expect(stalled.releaseError()).toBeInstanceOf(Error);
    pending.resolve({ rows: [] });
    await expect(
      withSourceRatingReadConnection(pool, Date.now() + 1_000, read, { repeatableRead: true }),
    ).resolves.toBe('current');
  });
}

test('a checkout arriving after expiry sends no SQL and is discarded', async () => {
  const checkout = deferred<PoolClient>();
  const late = connection();
  const attempt = withSourceRatingReadConnection(
    poolFor(() => checkout.promise),
    Date.now() + 100,
    read,
  );
  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  checkout.resolve(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeInstanceOf(Error);
});

test('a settled read failure rolls back within budget and preserves the original error', async () => {
  const failed = connection();
  const original = new Error('source observation read failed');
  await expect(
    withSourceRatingReadConnection(
      poolFor(async () => failed.client),
      Date.now() + 1_000,
      async () => {
        throw original;
      },
      { repeatableRead: true },
    ),
  ).rejects.toBe(original);
  expect(failed.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(failed.releaseError()).toBeUndefined();
});
