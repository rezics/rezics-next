import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withContinueReadSnapshot } from '../../src/library/continue-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeClient(
  query: (statement: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string) {
      return query(typeof input === 'string' ? input : input.text);
    },
    release,
  } as unknown as PoolClient;
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a checkout that arrives after expiry issues no SQL and is released', async () => {
  const checkout = deferred<PoolClient>();
  const statements: string[] = [];
  let released!: () => void;
  const releasedPromise = new Promise<void>((done) => (released = done));
  const connection = fakeClient(
    (statement) => {
      statements.push(statement);
      return { rows: [] };
    },
    () => released(),
  );
  const visit = withContinueReadSnapshot(fakePool(() => checkout.promise), Date.now() + 50, async (client) =>
    client.query('SELECT late'),
  );

  await expect(visit).rejects.toBeDefined();
  checkout.resolve(connection);
  await releasedPromise;
  expect(statements).toEqual([]);
});

test('a successful snapshot keeps repeatable-read isolation and commits', async () => {
  const statements: string[] = [];
  const pool = fakePool(async () =>
    fakeClient((statement) => {
      statements.push(statement);
      return { rows: [] };
    }),
  );

  const result = await withContinueReadSnapshot(pool, Date.now() + 500, async (client) => {
    await client.query('SELECT current');
    return 'current';
  });

  expect(result).toBe('current');
  expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT current', 'COMMIT']);
});

for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT slow', 'COMMIT']) {
  test(`a blocked ${blocked} discards the client and a later visit succeeds`, async () => {
    const never = new Promise<{ rows: unknown[] }>(() => {});
    const statements: string[] = [];
    let releaseError: Error | boolean | undefined;
    let released!: () => void;
    const releasedPromise = new Promise<void>((done) => (released = done));
    let checkouts = 0;
    const pool = fakePool(async () => {
      checkouts += 1;
      if (checkouts > 1)
        return fakeClient((statement) => {
          statements.push(statement);
          return { rows: [{ current: true }] };
        });
      return fakeClient(
        (statement) => {
          statements.push(statement);
          return statement === blocked ? never : { rows: [] };
        },
        (error) => {
          releaseError = error;
          released();
        },
      );
    });

    const visit = withContinueReadSnapshot(pool, Date.now() + 50, async (client) => {
      if (blocked === 'SELECT slow') await client.query(blocked);
      return true;
    });
    await expect(visit).rejects.toBeDefined();
    await releasedPromise;
    expect(releaseError).toBeInstanceOf(Error);
    expect(statements).not.toContain('ROLLBACK');

    const current = await withContinueReadSnapshot(pool, Date.now() + 500, async (client) =>
      client.query<{ current: boolean }>('SELECT current'),
    );
    expect(checkouts).toBe(2);
    expect(current.rows).toEqual([{ current: true }]);
  });
}

test('a read failure stays primary when rollback fails', async () => {
  const primary = new Error('read failed');
  let releaseError: Error | boolean | undefined;
  const pool = fakePool(async () =>
    fakeClient(
      (statement) =>
        statement === 'SELECT current'
          ? Promise.reject(primary)
          : statement === 'ROLLBACK'
            ? Promise.reject(new Error('rollback failed'))
            : { rows: [] },
      (error) => {
        releaseError = error;
      },
    ),
  );

  const error = await withContinueReadSnapshot(pool, Date.now() + 500, async (client) => {
    await client.query('SELECT current');
  }).catch((failure: unknown) => failure);

  expect(error).toBe(primary);
  expect(releaseError).toBeInstanceOf(Error);
});
