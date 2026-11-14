import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { withSubjectDiscussionReadSnapshot } from '../../src/content/subject-discussion-read-connection.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const result = () => Promise.resolve({ rows: [] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

function fakeClient(run: (sql: string) => Promise<unknown> = result) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let finishRelease!: () => void;
  const released = new Promise<void>((resolve) => (finishRelease = resolve));
  const client = {
    query(input: string | { text: string }) {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    },
    release(error?: Error) {
      releaseError = error;
      finishRelease();
    },
  } as unknown as PoolClient;
  return {
    client,
    statements,
    released,
    get releaseError() {
      return releaseError;
    },
  };
}

const pool = (connect: () => Promise<PoolClient>): Pool => ({ connect }) as unknown as Pool;

test('blocked BEGIN, read and COMMIT discard the client without queuing rollback', async () => {
  const never = new Promise<never>(() => {});
  const phases = [begin, 'SELECT page', 'COMMIT'];
  for (const blocked of phases) {
    const native = fakeClient((sql) => (sql === blocked ? never : result()));
    await expect(
      withSubjectDiscussionReadSnapshot(
        pool(() => Promise.resolve(native.client)),
        Date.now() + 40,
        async (client) => {
          await client.query('SELECT page');
          return true;
        },
      ),
    ).rejects.toThrow();
    await native.released;
    expect(native.statements).toEqual(phases.slice(0, phases.indexOf(blocked) + 1));
    expect(native.releaseError).toBeInstanceOf(Error);
  }
});

test('late checkout dispatches no SQL and a fresh visit succeeds', async () => {
  const checkout = deferred<PoolClient>();
  const late = fakeClient();
  const fresh = fakeClient();
  let count = 0;
  const nativePool = pool(() => (++count === 1 ? checkout.promise : Promise.resolve(fresh.client)));
  const expired = withSubjectDiscussionReadSnapshot(nativePool, Date.now() + 25, async () => 'late');
  await expect(expired).rejects.toThrow();
  checkout.resolve(late.client);
  await late.released;
  expect(late.statements).toEqual([]);
  await expect(withSubjectDiscussionReadSnapshot(nativePool, Date.now() + 1_000, async () => 'fresh')).resolves.toBe(
    'fresh',
  );
  expect(fresh.statements).toEqual([begin, 'COMMIT']);
});

test('an uncertain client is discarded without a queued rollback', async () => {
  const native = fakeClient((sql) => (sql === 'SELECT page' ? Promise.reject(new Error('connection lost')) : result()));
  await expect(
    withSubjectDiscussionReadSnapshot(
      pool(() => Promise.resolve(native.client)),
      Date.now() + 1_000,
      async (client) => {
        await client.query('SELECT page');
        return true;
      },
    ),
  ).rejects.toThrow();
  await native.released;
  expect(native.statements).toEqual([begin, 'SELECT page']);
  expect(native.releaseError).toBeInstanceOf(Error);
});

test('ordinary read failures retain their error and roll back within the deadline', async () => {
  const cleanup = new Error('rollback failed');
  const native = fakeClient((sql) => (sql === 'ROLLBACK' ? Promise.reject(cleanup) : result()));
  const failure = new Error('read failed');
  await expect(
    withSubjectDiscussionReadSnapshot(
      pool(() => Promise.resolve(native.client)),
      Date.now() + 1_000,
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(native.statements).toEqual([begin, 'ROLLBACK']);
  expect(native.releaseError).toBe(cleanup);
});
