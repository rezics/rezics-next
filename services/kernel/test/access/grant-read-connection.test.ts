import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withGrantReadConnection, withGrantReadSnapshot } from '../../src/access/grant-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function clientFor(
  run: (sql: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error) => void = () => {},
) {
  const statements: string[] = [];
  const client = {
    query(query: QueryConfig | string) {
      const sql = typeof query === 'string' ? query : (query.text ?? '');
      statements.push(sql);
      return run(sql);
    },
    release,
  } as unknown as PoolClient;
  return { client, statements };
}

function poolFor(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a late grant-read checkout issues no SQL and releases its client', async () => {
  const checkout = deferred<PoolClient>();
  const released = deferred<Error | undefined>();
  const late = clientFor(async () => ({ rows: [] }), (error) => released.resolve(error));
  const read = withGrantReadConnection(poolFor(() => checkout.promise), Date.now() + 40, (client) =>
    client.query('SELECT late'),
  );

  await expect(read).rejects.toThrow();
  checkout.resolve(late.client);
  const releaseError = await released.promise;

  expect(late.statements).toEqual([]);
  expect(releaseError).toBeUndefined();
});

test('a successful grant snapshot commits before releasing the client', async () => {
  let releaseError: Error | undefined;
  const source = clientFor(async () => ({ rows: [] }), (error) => (releaseError = error));
  await withGrantReadSnapshot(poolFor(async () => source.client), Date.now() + 1_000, (client) =>
    client.query('SELECT source'),
  );

  expect(source.statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT source',
    'COMMIT',
  ]);
  expect(releaseError).toBeUndefined();
});

for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT source', 'COMMIT']) {
  test(`a blocked ${blocked} discards its checkout without rollback and permits a later visit`, async () => {
    let firstRelease: Error | undefined;
    const never = new Promise<{ rows: unknown[] }>(() => {});
    const first = clientFor(
      (sql) => (sql === blocked ? never : { rows: [] }),
      (error) => (firstRelease = error),
    );
    const next = clientFor(async () => ({ rows: [{ current: true }] }));
    let checkouts = 0;
    const pool = poolFor(async () => (++checkouts === 1 ? first.client : next.client));

    await expect(
      withGrantReadSnapshot(pool, Date.now() + 50, async (client) => {
        if (blocked === 'SELECT source') await client.query(blocked);
      }),
    ).rejects.toThrow();

    expect(firstRelease).toBeInstanceOf(Error);
    expect(first.statements).not.toContain('ROLLBACK');
    const current = await withGrantReadConnection(pool, Date.now() + 1_000, (client) =>
      client.query<{ current: boolean }>('SELECT current'),
    );
    expect(checkouts).toBe(2);
    expect(current.rows).toEqual([{ current: true }]);
  });
}

test('a read error remains primary when rollback runs past the deadline', async () => {
  const primary = new Error('grant source read failed');
  let releaseError: Error | undefined;
  const source = clientFor(
    (sql) => {
      if (sql === 'SELECT source') throw primary;
      if (sql === 'ROLLBACK') return new Promise<never>(() => {});
      return { rows: [] };
    },
    (error) => (releaseError = error),
  );

  await expect(
    withGrantReadSnapshot(poolFor(async () => source.client), Date.now() + 50, async (client) => {
      await client.query('SELECT source');
    }),
  ).rejects.toBe(primary);

  expect(source.statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT source',
    'ROLLBACK',
  ]);
  expect(releaseError).toBeInstanceOf(Error);
});
