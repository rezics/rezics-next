import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { withQueryAccounting } from '../../src/database/pool.ts';
import {
  withManagementReadConnection,
  withManagementReadSnapshot,
} from '../../src/access/management-read-connection.ts';

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
const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

test('managed snapshots keep repeatable-read commit and query accounting', async () => {
  const client = fakeClient();
  const pool = fakePool(async () => client.client);
  const accounted: string[] = [];
  const value = await withQueryAccounting(
    {
      query(sql, _operands, dispatch) {
        accounted.push(sql);
        return dispatch();
      },
      connection(dispatch) {
        return dispatch();
      },
    },
    () =>
      withManagementReadSnapshot(pool, Date.now() + 1000, async (connection) => {
        await connection.query('SELECT 1');
        return 'handle';
      }),
  );

  expect(value).toBe('handle');
  expect(client.queries).toEqual([begin, 'SELECT 1', 'COMMIT']);
  expect(accounted).toEqual(client.queries);
  expect(client.releases).toEqual([undefined]);
});

test('uncertain BEGIN, source query and COMMIT discard the client without queued rollback', async () => {
  for (const phase of [begin, 'SELECT 1', 'COMMIT']) {
    let finish!: () => void;
    const first = fakeClient((sql) =>
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
      withManagementReadSnapshot(pool, Date.now() + 100, async (client) => {
        await client.query('SELECT 1');
        return 'handle';
      }),
    ).rejects.toThrow();
    expect(first.releases[0]).toBeInstanceOf(Error);
    expect(first.queries).toEqual(
      phase === begin ? [begin] : phase === 'SELECT 1' ? [begin, phase] : [begin, 'SELECT 1', phase],
    );
    finish();

    expect(
      await withManagementReadSnapshot(pool, Date.now() + 1000, async (client) => {
        await client.query('SELECT 1');
        return 'handle';
      }),
    ).toBe('handle');
    expect(next.queries).toEqual([begin, 'SELECT 1', 'COMMIT']);
    expect(next.releases).toEqual([undefined]);
  }
});

test('a late checkout performs no SQL and releases its client healthy', async () => {
  let deliver!: (client: PoolClient) => void;
  const pending = new Promise<PoolClient>((resolve) => {
    deliver = resolve;
  });
  const pool = fakePool(() => pending);
  const visit = withManagementReadConnection(pool, Date.now() + 100, async (client) => {
    await client.query('SELECT handle');
    return 'handle';
  });

  await expect(visit).rejects.toThrow();
  const late = fakeClient();
  deliver(late.client);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(late.queries).toEqual([]);
  expect(late.releases).toEqual([undefined]);
});

test('a failed source keeps its error when rollback reaches the deadline', async () => {
  const primary = new Error('source failed');
  const client = fakeClient((sql) => (sql === 'ROLLBACK' ? blocked() : Promise.resolve({ rows: [] })));
  const pool = fakePool(async () => client.client);

  await expect(
    withManagementReadSnapshot(pool, Date.now() + 100, async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(client.queries).toEqual([begin, 'ROLLBACK']);
  expect(client.releases[0]).toBeInstanceOf(Error);
});
