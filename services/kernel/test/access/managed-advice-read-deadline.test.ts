import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { mintReadTime } from '../../src/command/command.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import {
  withManagedAdviceReadConnection,
  withManagedAdviceReadSnapshot,
} from '../../src/access/managed-advice-read-connection.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => (resolve = resolvePromise));
  return { promise, resolve };
}

const emptyResult = { rows: [] };

function fakeClient(run: (sql: string) => Promise<unknown> = async () => emptyResult) {
  const queries: string[] = [];
  const releases: (Error | undefined)[] = [];
  const released = deferred<void>();
  const client = {
    query(query: unknown) {
      const sql = typeof query === 'string' ? query : String((query as { text?: unknown } | null)?.text ?? '');
      queries.push(sql);
      return run(sql);
    },
    release(error?: Error) {
      releases.push(error);
      released.resolve();
    },
  } as unknown as PoolClient;
  return { client, queries, releases, released };
}

function fakePool(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('a checkout that finishes after expiry releases without issuing source SQL', async () => {
  const connection = deferred<PoolClient>();
  const source = fakeClient();
  const result = withManagedAdviceReadConnection(
    fakePool(() => connection.promise),
    Date.now() + 30,
    (client) => mintReadTime(client, () => new Date('2026-11-14T00:00:00.000Z')),
  );

  await expect(result).rejects.toBeInstanceOf(AccessUnavailableError);
  connection.resolve(source.client);
  await source.released.promise;

  expect(source.queries).toEqual([]);
  expect(source.releases).toEqual([undefined]);
});

test('expired BEGIN, source observation, and COMMIT discard uncertain clients', async () => {
  for (const phase of ['begin', 'read', 'commit'] as const) {
    const pending = deferred<unknown>();
    const reached = deferred<void>();
    const blockedSql =
      phase === 'begin'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : phase === 'commit'
          ? 'COMMIT'
          : 'SELECT managed advice';
    const source = fakeClient(async (sql) => {
      if (sql === blockedSql) {
        reached.resolve();
        return pending.promise;
      }
      return { rows: [] };
    });
    const next = fakeClient();
    let acquisitions = 0;
    const pool = fakePool(async () => (acquisitions++ === 0 ? source.client : next.client));
    const visit = withManagedAdviceReadSnapshot(
      pool,
      Date.now() + 30,
      async (client) => (phase === 'read' ? client.query(blockedSql) : 'current'),
    );

    await reached.promise;
    await expect(visit).rejects.toBeInstanceOf(AccessUnavailableError);
    expect(source.queries).toEqual(
      phase === 'begin' ? [blockedSql] : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', blockedSql],
    );
    expect(source.releases[0]).toBeInstanceOf(Error);
    pending.resolve({ rows: [] });

    if (phase === 'read') {
      let accountedCheckouts = 0;
      const current = await withQueryAccounting(
        {
          query: (_sql, _operands, dispatch) => dispatch(),
          connection: (dispatch) => {
            accountedCheckouts += 1;
            return dispatch();
          },
        },
        () =>
          withManagedAdviceReadSnapshot(pool, Date.now() + 1_000, async (client) => {
            await client.query('SELECT current advice');
            return 'current';
          }),
      );

      expect(current).toBe('current');
      expect(next.queries).toEqual([
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        'SELECT current advice',
        'COMMIT',
      ]);
      expect(next.releases).toEqual([undefined]);
      expect(accountedCheckouts).toBe(1);
    }
  }
});

test('bounded rollback failure preserves the source error and discards its client', async () => {
  const rollback = deferred<unknown>();
  const rollbackStarted = deferred<void>();
  const source = fakeClient(async (sql) => {
    if (sql === 'ROLLBACK') {
      rollbackStarted.resolve();
      return rollback.promise;
    }
    return { rows: [] };
  });
  const primary = new Error('current advice observation failed');
  const visit = withManagedAdviceReadSnapshot(
    fakePool(async () => source.client),
    Date.now() + 40,
    async () => {
      throw primary;
    },
  );

  await rollbackStarted.promise;
  await expect(visit).rejects.toBe(primary);

  expect(source.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(source.releases[0]).toBeInstanceOf(Error);
  rollback.resolve({ rows: [] });
});
