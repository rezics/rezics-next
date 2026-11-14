import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withCollectionDiscoveryReadSnapshot } from '../../src/library/collection-discovery-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function client(
  query: (statement: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string) {
      return query(typeof input === 'string' ? input : (input.text ?? ''));
    },
    release,
  } as unknown as PoolClient;
}

function pool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a checkout arriving after expiry sends no SQL and releases the client', async () => {
  const checkout = deferred<PoolClient>();
  const statements: string[] = [];
  const released = deferred<void>();
  let releaseError: Error | boolean | undefined;
  const late = client(
    (statement) => {
      statements.push(statement);
      return { rows: [] };
    },
    (error) => {
      releaseError = error;
      released.resolve();
    },
  );
  const visit = withCollectionDiscoveryReadSnapshot(pool(() => checkout.promise), Date.now() + 30, (connection) =>
    connection.query('SELECT late'),
  );

  await expect(visit).rejects.toBeDefined();
  checkout.resolve(late);
  await released.promise;
  expect(statements).toEqual([]);
  expect(releaseError).toBeUndefined();
});

test('blocked transaction phases discard the client without rollback and leave capacity usable', async () => {
  for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT slow', 'COMMIT']) {
    const never = new Promise<{ rows: unknown[] }>(() => {});
    const statements: string[] = [];
    const released = deferred<void>();
    let releaseError: Error | boolean | undefined;
    let checkouts = 0;
    const database = pool(async () => {
      checkouts += 1;
      if (checkouts > 1) return client(() => ({ rows: [{ current: true }] }));
      return client(
        (statement) => {
          statements.push(statement);
          return statement === blocked ? never : { rows: [] };
        },
        (error) => {
          releaseError = error;
          released.resolve();
        },
      );
    });

    const read = withCollectionDiscoveryReadSnapshot(database, Date.now() + 40, async (connection) => {
      if (blocked === 'SELECT slow') await connection.query(blocked);
      return true;
    });
    await expect(read).rejects.toBeDefined();
    await released.promise;
    expect(releaseError).toBeDefined();
    expect(statements).not.toContain('ROLLBACK');

    const current = await withCollectionDiscoveryReadSnapshot(database, Date.now() + 500, (connection) =>
      connection.query<{ current: boolean }>('SELECT current'),
    );
    expect(checkouts).toBe(2);
    expect(current.rows).toEqual([{ current: true }]);
  }
});

test('successful snapshots commit and cleanup errors preserve the original read failure', async () => {
  const statements: string[] = [];
  const committed = await withCollectionDiscoveryReadSnapshot(
    pool(async () =>
      client((statement) => {
        statements.push(statement);
        return { rows: [] };
      }),
    ),
    Date.now() + 500,
    async (connection) => {
      await connection.query('SELECT current');
      return 'current';
    },
  );
  expect(committed).toBe('current');
  expect(statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT current',
    'COMMIT',
  ]);

  const primary = new Error('read failed');
  const failure = await withCollectionDiscoveryReadSnapshot(
    pool(async () =>
      client((statement) => (statement === 'ROLLBACK' ? Promise.reject(new Error('cleanup failed')) : { rows: [] })),
    ),
    Date.now() + 500,
    async () => {
      throw primary;
    },
  ).catch((error: unknown) => error);
  expect(failure).toBe(primary);
});
