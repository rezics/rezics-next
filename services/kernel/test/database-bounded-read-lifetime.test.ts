import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import {
  BoundedReadDeadlineError,
  NestedPoolCheckoutError,
  RetiredReadClientError,
  withBoundedReadConnection,
  withBoundedReadOnlyTransaction,
  withConnection,
  withQueryAccounting,
  type QueryAccounting,
} from '../src/database/pool.ts';
import { withContinueReadSnapshot } from '../src/library/continue-read-connection.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeClient(
  query: (config: QueryConfig) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string, values?: unknown[]) {
      return query(typeof input === 'string' ? { text: input, ...(values === undefined ? {} : { values }) } : input);
    },
    release,
  } as unknown as PoolClient;
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a late checkout is released without dispatching SQL', async () => {
  const checkout = deferred<PoolClient>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const late = fakeClient(
    (config) => {
      statements.push(config.text ?? '');
      return { rows: [] };
    },
    (error) => released.resolve(error),
  );
  const visit = withBoundedReadOnlyTransaction(
    fakePool(() => checkout.promise),
    Date.now() + 40,
    async (client) => client.query('SELECT late'),
  );

  await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
  checkout.resolve(late);
  expect(await released.promise).toBeUndefined();
  expect(statements).toEqual([]);
});

test('uncertain transaction phases discard the client and the next read uses a healthy checkout', async () => {
  for (const blocked of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT slow', 'COMMIT']) {
    const never = new Promise<{ rows: unknown[] }>(() => {});
    const statements: string[] = [];
    const released = deferred<Error | boolean | undefined>();
    let checkouts = 0;
    const database = fakePool(async () => {
      checkouts += 1;
      if (checkouts > 1) return fakeClient((config) => ({ rows: [{ healthy: config.text === 'SELECT healthy' }] }));
      return fakeClient(
        (config) => {
          statements.push(config.text ?? '');
          return config.text === blocked ? never : { rows: [] };
        },
        (error) => released.resolve(error),
      );
    });

    const expired = withBoundedReadOnlyTransaction(database, Date.now() + 40, async (client) => {
      if (blocked === 'SELECT slow') await client.query(blocked);
      return 'old';
    });
    await expect(expired).rejects.toBeInstanceOf(BoundedReadDeadlineError);
    expect(await released.promise).toBeInstanceOf(Error);
    expect(statements).not.toContain('ROLLBACK');

    const healthy = await withBoundedReadOnlyTransaction(database, Date.now() + 500, (client) =>
      client.query<{ healthy: boolean }>('SELECT healthy'),
    );
    expect(healthy.rows).toEqual([{ healthy: true }]);
    expect(checkouts).toBe(2);
  }
});

test('settled PostgreSQL failures roll back safely and rollback failures preserve the first error', async () => {
  const readError = Object.assign(new Error('read failed'), { code: '23505', severity: 'ERROR' });
  const safeStatements: string[] = [];
  let safeReleaseError: Error | boolean | undefined;
  const safePool = fakePool(async () =>
    fakeClient(
      (config) => {
        safeStatements.push(config.text ?? '');
        return config.text === 'SELECT rejected' ? Promise.reject(readError) : { rows: [] };
      },
      (error) => {
        safeReleaseError = error;
      },
    ),
  );
  const safeFailure = await withBoundedReadOnlyTransaction(safePool, Date.now() + 500, async (client) => {
    await client.query('SELECT rejected');
  }).catch((error: unknown) => error);
  expect(safeFailure).toBe(readError);
  expect(safeStatements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT rejected', 'ROLLBACK']);
  expect(safeReleaseError).toBeUndefined();

  const rollbackError = new Error('rollback outcome unknown');
  let failedReleaseError: Error | boolean | undefined;
  const failedPool = fakePool(async () =>
    fakeClient(
      (config) =>
        config.text === 'SELECT rejected'
          ? Promise.reject(readError)
          : config.text === 'ROLLBACK'
            ? Promise.reject(rollbackError)
            : { rows: [] },
      (error) => {
        failedReleaseError = error;
      },
    ),
  );
  const rollbackFailure = await withBoundedReadOnlyTransaction(failedPool, Date.now() + 500, async (client) => {
    await client.query('SELECT rejected');
  }).catch((error: unknown) => error);
  expect(rollbackFailure).toBe(readError);
  expect(failedReleaseError).toBe(rollbackError);
});

test('an expired callback cannot use its released client', async () => {
  const resume = deferred<void>();
  const callbackFinished = deferred<unknown>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const database = fakePool(async () =>
    fakeClient(
      (config) => {
        statements.push(config.text ?? '');
        return { rows: [] };
      },
      (error) => released.resolve(error),
    ),
  );
  const visit = withBoundedReadConnection(database, Date.now() + 40, async (client) => {
    await resume.promise;
    const error = await client.query('SELECT stale').catch((failure: unknown) => failure);
    callbackFinished.resolve(error);
    return 'stale';
  });

  await expect(visit).rejects.toBeInstanceOf(BoundedReadDeadlineError);
  expect(await released.promise).toBeUndefined();
  resume.resolve();
  expect(await callbackFinished.promise).toBeInstanceOf(RetiredReadClientError);
  expect(statements).toEqual([]);
});

test('nested checkout is refused before another physical connection is requested', async () => {
  let checkouts = 0;
  const database = fakePool(async () => {
    checkouts += 1;
    return fakeClient(() => ({ rows: [] }));
  });

  await expect(
    withBoundedReadConnection(database, Date.now() + 500, async () => withConnection(database, async () => 'nested')),
  ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  expect(checkouts).toBe(1);
});

test('an adopted Continue reader preserves SQL options and accounts one checkout and each query once', async () => {
  const submitted: QueryConfig[] = [];
  const accounted: string[] = [];
  let connections = 0;
  const database = fakePool(async () =>
    fakeClient((config) => {
      submitted.push(config);
      return { rows: config.text === 'SELECT current' ? [['ready']] : [] };
    }),
  );
  const accounting: QueryAccounting = {
    query<T>(sql: string, _operands: readonly unknown[], dispatch: () => Promise<T>): Promise<T> {
      accounted.push(sql);
      return dispatch();
    },
    connection<T>(dispatch: () => Promise<T>): Promise<T> {
      connections += 1;
      return dispatch();
    },
  };
  const types = { getTypeParser: () => (value: string) => value };
  const request: QueryConfig = {
    text: 'SELECT current',
    values: ['route'],
    rowMode: 'array',
    types,
  };

  const rows = await withQueryAccounting(accounting, () =>
    withContinueReadSnapshot(database, Date.now() + 500, async (client) => {
      const result = await client.query<{ current: string }>(request);
      return result.rows;
    }),
  );

  expect(rows).toEqual([['ready']]);
  expect(submitted.map(({ text }) => text)).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT current',
    'COMMIT',
  ]);
  expect(submitted[1]?.rowMode).toBe('array');
  expect(submitted[1]?.types).toBe(types);
  expect(submitted[1]?.values).toBe(request.values);
  expect(accounted).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT current', 'COMMIT']);
  expect(connections).toBe(1);
});
