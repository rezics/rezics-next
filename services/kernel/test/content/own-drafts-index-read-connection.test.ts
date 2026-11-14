import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withOwnDraftReadConnection } from '../../src/content/own-drafts-index-read-connection.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import type { AccessClient } from '../../src/request/access.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  const released = deferred<void>();
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released.resolve();
    },
  } as unknown as PoolClient;
  return { client, statements, released, releaseError: () => releaseError };
}

const poolFor = (connect: () => Promise<PoolClient>) => ({ connect }) as unknown as Pool;
const visit = (pool: Pool, deadline: number) =>
  withOwnDraftReadConnection(pool, deadline, async (client: AccessClient) => {
    await client.query('SELECT source');
    return 'current source';
  });
const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

test('draft read commits its repeatable-read snapshot and preserves query accounting', async () => {
  const current = connection();
  const statements: string[] = [];
  await withQueryAccounting(
    {
      query: (sql, _operands, dispatch) => {
        statements.push(sql);
        return dispatch();
      },
      connection: (dispatch) => dispatch(),
    },
    () => expect(visit(poolFor(async () => current.client), Date.now() + 1000)).resolves.toBe('current source'),
  );
  expect(current.statements).toEqual([begin, 'SELECT source', 'COMMIT']);
  expect(statements).toEqual(current.statements);
  expect(current.releaseError()).toBeUndefined();
});

for (const blocked of [begin, 'SELECT source', 'COMMIT']) {
  test(`an expired ${blocked} discards unresolved I/O and the next draft read succeeds`, async () => {
    const reached = deferred<void>();
    const pending = deferred<unknown>();
    const stalled = connection((sql) => {
      if (!sql.startsWith(blocked)) return Promise.resolve({ rows: [] });
      reached.resolve();
      return pending.promise;
    });
    const next = connection();
    const clients = [stalled, next];
    const pool = poolFor(async () => clients.shift()!.client);
    const attempt = visit(pool, Date.now() + 80);
    await reached.promise;
    await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
    pending.resolve({ rows: [] });
    await stalled.released.promise;
    expect(stalled.statements).not.toContain('ROLLBACK');
    expect(stalled.releaseError()).toBeInstanceOf(Error);
    await expect(visit(pool, Date.now() + 1000)).resolves.toBe('current source');
    expect(next.statements.at(-1)).toBe('COMMIT');
  });
}

test('a checkout arriving after expiry issues no SQL', async () => {
  const checkout = deferred<PoolClient>();
  const attempt = visit(poolFor(() => checkout.promise), Date.now() + 60);
  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  checkout.resolve(late.client);
  await late.released.promise;
  expect(late.statements).toEqual([]);
});

test('a read error survives successful rollback and an expired rollback', async () => {
  const original = new Error('draft source failed');
  const current = connection();
  await expect(
    withOwnDraftReadConnection(poolFor(async () => current.client), Date.now() + 1000, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(current.statements).toEqual([begin, 'ROLLBACK']);

  const rollbackStarted = deferred<void>();
  const stalled = connection((sql) => {
    if (sql === 'ROLLBACK') {
      rollbackStarted.resolve();
      return new Promise<never>(() => {});
    }
    return Promise.resolve({ rows: [] });
  });
  const failed = withOwnDraftReadConnection(poolFor(async () => stalled.client), Date.now() + 80, async () => {
    throw original;
  });
  await rollbackStarted.promise;
  await expect(failed).rejects.toBe(original);
  await stalled.released.promise;
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});
