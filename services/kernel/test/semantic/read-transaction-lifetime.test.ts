import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { RetiredReadClientError } from '../../src/database/pool.ts';
import { currentReadSnapshot, withReadTransaction } from '../../src/semantic/read.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fakeClient(
  query: (sql: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string) {
      return query(typeof input === 'string' ? input : (input.text ?? ''));
    },
    release,
  } as unknown as PoolClient;
}
const fakePool = (connect: () => Promise<PoolClient>) => ({ connect }) as unknown as Pool;

test('late checkout releases without dispatching SQL', async () => {
  const checkout = deferred<PoolClient>(),
    released = deferred<Error | boolean | undefined>(),
    sql: string[] = [];
  const visit = withReadTransaction(
    fakePool(() => checkout.promise),
    (tx) => tx.query('SELECT late'),
    Date.now() + 30,
  );
  await expect(visit).rejects.toBeInstanceOf(AccessUnavailableError);
  checkout.resolve(
    fakeClient(
      (text) => (sql.push(text), { rows: [] }),
      (error) => released.resolve(error),
    ),
  );
  expect(await released.promise).toBeUndefined();
  expect(sql).toEqual([]);
});

test('uncertain phases discard without rollback and the next read succeeds', async () => {
  for (const phase of ['BEGIN', 'SET', 'SELECT', 'COMMIT'] as const) {
    const never = new Promise<{ rows: unknown[] }>(() => {}),
      sql: string[] = [],
      released = deferred<Error | boolean | undefined>();
    let checkouts = 0;
    const matches = (text: string) =>
      phase === 'BEGIN'
        ? text.startsWith('BEGIN')
        : phase === 'SET'
          ? text.startsWith('SET LOCAL')
          : text === (phase === 'SELECT' ? 'SELECT slow' : 'COMMIT');
    const database = fakePool(async () => {
      checkouts++;
      return fakeClient(
        (text) => {
          sql.push(text);
          return checkouts === 1 && matches(text) ? never : { rows: [{ healthy: text === 'SELECT healthy' }] };
        },
        (error) => {
          if (checkouts === 1) released.resolve(error);
        },
      );
    });
    const expired = withReadTransaction(
      database,
      (tx) => (phase === 'SELECT' ? tx.query('SELECT slow') : Promise.resolve('old')),
      Date.now() + 30,
    );
    await expect(expired).rejects.toBeInstanceOf(AccessUnavailableError);
    expect(await released.promise).toBeInstanceOf(Error);
    expect(sql).not.toContain('ROLLBACK');
    expect(
      (await withReadTransaction(database, (tx) => tx.query<{ healthy: boolean }>('SELECT healthy'))).rows,
    ).toEqual([{ healthy: true }]);
    expect(checkouts).toBe(2);
  }
});

test('expiry retires escaped callbacks and narrower children cannot use the snapshot late', async () => {
  const resume = deferred<void>(),
    callback = deferred<{ retired: boolean; error: unknown }>(),
    released = deferred<Error | boolean | undefined>(),
    sql: string[] = [];
  const database = fakePool(async () =>
    fakeClient(
      (text) => (sql.push(text), { rows: [] }),
      (error) => released.resolve(error),
    ),
  );
  const expired = withReadTransaction(
    database,
    async (tx) => {
      await resume.promise;
      let error: unknown;
      try {
        await tx.query('SELECT late');
      } catch (failure) {
        error = failure;
      }
      callback.resolve({ retired: currentReadSnapshot(database) === undefined, error });
      return null;
    },
    Date.now() + 30,
  );
  await expect(expired).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(await released.promise).toBeInstanceOf(Error);
  resume.resolve(undefined);
  const result = await callback.promise;
  expect(result.retired).toBe(true);
  expect(result.error).toBeInstanceOf(RetiredReadClientError);
  expect(sql).not.toContain('SELECT late');

  let checkouts = 0;
  const childSql: string[] = [];
  const nested = fakePool(async () => {
    checkouts++;
    return fakeClient((text) => (childSql.push(text), { rows: [] }));
  });
  await withReadTransaction(
    nested,
    async (outer) => {
      const child = withReadTransaction(
        nested,
        async (inner) => {
          await Bun.sleep(30);
          return inner.query('SELECT late child');
        },
        Date.now() + 15,
      );
      await expect(child).rejects.toBeInstanceOf(AccessUnavailableError);
      expect(currentReadSnapshot(nested)).toBe(outer);
      await outer.query('SELECT parent');
    },
    Date.now() + 500,
  );
  expect(checkouts).toBe(1);
  expect(childSql).not.toContain('SELECT late child');
  expect(childSql).toContain('SELECT parent');
});

test('nested reads reuse one checkout and preserve a settled failure through rollback', async () => {
  const failure = Object.assign(new Error('settled read failure'), { code: '23505', severity: 'ERROR' }),
    sql: string[] = [];
  let checkouts = 0;
  const database = fakePool(async () => {
    checkouts++;
    return fakeClient((text) => {
      sql.push(text);
      return text === 'SELECT failed' ? Promise.reject(failure) : { rows: [] };
    });
  });
  const result = await withReadTransaction(
    database,
    (outer) =>
      withReadTransaction(database, async (inner) => {
        expect(currentReadSnapshot(database)).toBe(outer);
        await inner.query('SELECT failed');
      }),
    Date.now() + 500,
  ).catch((error: unknown) => error);
  expect(result).toBe(failure);
  expect(checkouts).toBe(1);
  expect(sql.slice(-2)).toEqual(['SELECT failed', 'ROLLBACK']);
});
