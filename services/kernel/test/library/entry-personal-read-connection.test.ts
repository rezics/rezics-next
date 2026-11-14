import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withEntryPersonalReadSnapshot } from '../../src/library/entry-personal-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function client(run: (sql: string) => Promise<unknown>, onRelease: (error?: Error | boolean) => void = () => {}) {
  const statements: string[] = [];
  const value = {
    query(input: QueryConfig | string) {
      const sql = typeof input === 'string' ? input : (input.text ?? '');
      statements.push(sql);
      return run(sql);
    },
    release: onRelease,
  } as unknown as PoolClient;
  return { client: value, statements };
}

function pool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a checkout arriving after expiry sends no SQL and releases the untouched client', async () => {
  const checkout = deferred<PoolClient>();
  let released!: (error?: Error | boolean) => void;
  let releaseError: Error | boolean | undefined;
  const releasedPromise = new Promise<void>((resolve) => {
    released = (error) => {
      releaseError = error;
      resolve();
    };
  });
  const late = client(
    async () => ({ rows: [] }),
    (error) => released(error),
  );
  const read = withEntryPersonalReadSnapshot(
    pool(() => checkout.promise),
    Date.now() + 40,
    async (connection) => connection.query('SELECT late'),
  );

  await expect(read).rejects.toBeDefined();
  checkout.resolve(late.client);
  await releasedPromise;
  expect(late.statements).toEqual([]);
  expect(releaseError).toBeUndefined();
});

test('a successful read commits its repeatable-read snapshot', async () => {
  const statements: string[] = [];
  const connection = client(async (sql) => {
    statements.push(sql);
    return { rows: [] };
  });

  const result = await withEntryPersonalReadSnapshot(
    pool(async () => connection.client),
    Date.now() + 1_000,
    async (query) => {
      await query.query('SELECT private entry');
      return 'private entry';
    },
  );

  expect(result).toBe('private entry');
  expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT private entry', 'COMMIT']);
});

for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT private entry', 'COMMIT']) {
  test(`an unsettled ${blocked} is discarded without queued rollback and the next visit succeeds`, async () => {
    const pending = deferred<unknown>();
    let heldReleaseError: Error | boolean | undefined;
    let heldReleased!: () => void;
    const heldReleasedPromise = new Promise<void>((resolve) => (heldReleased = resolve));
    const held = client(
      (sql) => (sql === blocked ? pending.promise : Promise.resolve({ rows: [] })),
      (error) => {
        heldReleaseError = error;
        heldReleased();
      },
    );
    const next = client(async () => ({ rows: [{ value: 'current' }] }));
    let checkouts = 0;
    const sharedPool = pool(async () => {
      checkouts += 1;
      return checkouts === 1 ? held.client : next.client;
    });
    const read = withEntryPersonalReadSnapshot(sharedPool, Date.now() + 60, async (query) => {
      if (blocked === 'SELECT private entry') await query.query(blocked);
      return true;
    });

    await expect(read).rejects.toBeDefined();
    await heldReleasedPromise;
    expect(held.statements).not.toContain('ROLLBACK');
    expect(heldReleaseError).toBeInstanceOf(Error);
    pending.resolve({ rows: [] });

    const current = await withEntryPersonalReadSnapshot(sharedPool, Date.now() + 1_000, async (query) => {
      const row = await query.query<{ value: string }>('SELECT current');
      return row.rows[0]?.value;
    });
    expect(current).toBe('current');
    expect(checkouts).toBe(2);
  });
}

test('rollback failure preserves the original read error and discards the client', async () => {
  const primary = new Error('private entry read failed');
  let releaseError: Error | boolean | undefined;
  const connection = client(
    async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    },
    (error) => {
      releaseError = error;
    },
  );

  const failure = await withEntryPersonalReadSnapshot(
    pool(async () => connection.client),
    Date.now() + 1_000,
    async () => {
      throw primary;
    },
  ).catch((error: unknown) => error);

  expect(failure).toBe(primary);
  expect(connection.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(releaseError).toBeInstanceOf(Error);
});
