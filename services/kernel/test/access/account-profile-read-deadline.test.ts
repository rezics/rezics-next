import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { withAccountProfileReadSnapshot } from '../../src/access/account-profile-read-connection.ts';

type FakeClient = { client: PoolClient; queries: string[]; releases: (Error | undefined)[] };

function fakeClient(query: (sql: string) => Promise<unknown> = async () => ({ rows: [] })): FakeClient {
  const queries: string[] = [];
  const releases: (Error | undefined)[] = [];
  const client = {
    async query(statement: string | { text: string }) {
      const sql = typeof statement === 'string' ? statement : statement.text;
      queries.push(sql);
      return query(sql);
    },
    release(error?: Error) {
      releases.push(error);
    },
  } as unknown as PoolClient;
  return { client, queries, releases };
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

const blocked = () => new Promise<never>(() => {});

test('uncertain snapshot phases discard their client and the next profile visit can use a fresh one', async () => {
  for (const phase of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', 'COMMIT']) {
    let finish!: () => void;
    const first = fakeClient(
      (sql) =>
        sql === phase
          ? new Promise((resolve) => {
              finish = () => resolve({ rows: [] });
            })
          : Promise.resolve({ rows: [] }),
    );
    const next = fakeClient();
    const clients = [first, next];
    const pool = fakePool(async () => clients.shift()!.client);

    await expect(
      withAccountProfileReadSnapshot(pool, Date.now() + 100, async (client) => {
        await client.query('SELECT 1');
        return 'profile';
      }),
    ).rejects.toThrow();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.releases[0]).toBeInstanceOf(Error);
    const expected =
      phase === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        ? [phase]
        : phase === 'SELECT 1'
          ? ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', phase]
          : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', phase];
    expect(first.queries).toEqual(expected);

    const profile = await withAccountProfileReadSnapshot(pool, Date.now() + 500, async (client) => {
      await client.query('SELECT 1');
      return 'profile';
    });
    expect(profile).toBe('profile');
    expect(next.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', 'COMMIT']);
    expect(next.releases).toEqual([undefined]);
  }
});

test('a late checkout performs no SQL and releases its client healthy', async () => {
  let deliver!: (client: PoolClient) => void;
  const pending = new Promise<PoolClient>((resolve) => {
    deliver = resolve;
  });
  const pool = fakePool(() => pending);
  const visit = withAccountProfileReadSnapshot(pool, Date.now() + 100, async (client) => {
    await client.query('SELECT 1');
    return 'profile';
  });

  await expect(visit).rejects.toThrow();
  const late = fakeClient();
  deliver(late.client);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(late.queries).toEqual([]);
  expect(late.releases).toEqual([undefined]);
});

test('an unresolved rollback discards the client and keeps the source error', async () => {
  const primary = new Error('source failed');
  const client = fakeClient((sql) => (sql === 'ROLLBACK' ? blocked() : Promise.resolve({ rows: [] })));
  const pool = fakePool(async () => client.client);

  await expect(
    withAccountProfileReadSnapshot(pool, Date.now() + 120, async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(client.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(client.releases[0]).toBeInstanceOf(Error);
});
