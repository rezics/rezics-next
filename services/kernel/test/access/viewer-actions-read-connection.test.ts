import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withViewerActionsReadSnapshot } from '../../src/access/viewer-actions-read-connection.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function clientFor(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const queries: string[] = [];
  const releases: (Error | undefined)[] = [];
  const released = deferred<void>();
  const client = {
    query(query: QueryConfig | string) {
      const sql = typeof query === 'string' ? query : (query.text ?? '');
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

function poolFor(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

test('late checkout releases without starting SQL', async () => {
  const checkout = deferred<PoolClient>();
  const source = clientFor();
  const visit = withViewerActionsReadSnapshot(poolFor(() => checkout.promise), Date.now() + 30, (client) =>
    client.query('SELECT late advice'),
  );

  await expect(visit).rejects.toBeInstanceOf(AccessUnavailableError);
  checkout.resolve(source.client);
  await source.released.promise;
  expect(source.queries).toEqual([]);
  expect(source.releases).toEqual([undefined]);
});

test('expired BEGIN, resource read, and COMMIT discard uncertain checkouts; the next read commits normally', async () => {
  for (const phase of ['begin', 'read', 'commit'] as const) {
    const pending = deferred<unknown>();
    const reached = deferred<void>();
    const blockedSql =
      phase === 'begin'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : phase === 'commit'
          ? 'COMMIT'
          : 'SELECT advice';
    const source = clientFor((sql) => {
      if (sql === blockedSql) {
        reached.resolve();
        return pending.promise;
      }
      return Promise.resolve({ rows: [] });
    });
    const next = clientFor();
    let acquired = 0;
    const pool = poolFor(async () => (acquired++ === 0 ? source.client : next.client));
    const visit = withViewerActionsReadSnapshot(pool, Date.now() + 40, async (client) => {
      if (phase === 'read') await client.query(blockedSql);
      return 'advice';
    });

    await reached.promise;
    await expect(visit).rejects.toBeInstanceOf(AccessUnavailableError);
    await source.released.promise;
    expect(source.queries).toEqual(
      phase === 'begin' ? [blockedSql] : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', blockedSql],
    );
    expect(source.releases[0]).toBeInstanceOf(Error);
    pending.resolve({ rows: [] });

    if (phase === 'read') {
      let accountedCheckouts = 0;
      const result = await withQueryAccounting(
        {
          query: (_sql, _operands, dispatch) => dispatch(),
          connection: (dispatch) => {
            accountedCheckouts += 1;
            return dispatch();
          },
        },
        () =>
          withViewerActionsReadSnapshot(pool, Date.now() + 1_000, async (client) => {
            await client.query('SELECT current advice');
            return 'current';
          }),
      );
      expect(result).toBe('current');
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

test('rollback failure preserves the read error and discards the client', async () => {
  const primary = new Error('resource advice failed');
  const source = clientFor(async (sql) => {
    if (sql === 'ROLLBACK') throw new Error('rollback failed');
    return { rows: [] };
  });

  await expect(
    withViewerActionsReadSnapshot(poolFor(async () => source.client), Date.now() + 1_000, async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(source.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(source.releases[0]).toBeInstanceOf(Error);
});
