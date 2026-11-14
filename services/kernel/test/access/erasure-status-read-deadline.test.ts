import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { authoritativeTimeValue, type AuthoritativeTime } from '../../src/command/command.ts';
import { readManagedErasureStatus } from '../../src/access/erasure-status-read.ts';
import {
  withErasureStatusReadConnection,
  withErasureStatusReadSnapshot,
} from '../../src/access/erasure-status-read-connection.ts';
import type { Access } from '../../src/access/check.ts';
import type { Actor } from '../../src/request/access.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => (resolve = resolvePromise));
  return { promise, resolve };
}

function fakeClient(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const queries: string[] = [];
  const releases: (Error | undefined)[] = [];
  const released = deferred<void>();
  const client = {
    query(statement: unknown) {
      const sql = typeof statement === 'string' ? statement : String((statement as { text?: unknown })?.text ?? '');
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

const blocked = () => new Promise<never>(() => {});

test('late checkout performs no SQL and uncertain snapshot phases discard before the next visit', async () => {
  const checkout = deferred<PoolClient>();
  const lateClient = fakeClient();
  const lateVisit = withErasureStatusReadConnection(
    fakePool(() => checkout.promise),
    Date.now() + 40,
    async (client) => {
      await client.query('SELECT late checkout');
    },
  );
  await expect(lateVisit).rejects.toThrow();
  checkout.resolve(lateClient.client);
  await lateClient.released.promise;
  expect(lateClient.queries).toEqual([]);
  expect(lateClient.releases).toEqual([undefined]);

  for (const phase of ['begin', 'read', 'commit'] as const) {
    const pending = deferred<unknown>();
    const reached = deferred<void>();
    const blockedSql =
      phase === 'begin'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : phase === 'commit'
          ? 'COMMIT'
          : 'SELECT erasure status';
    const first = fakeClient(async (sql) => {
      if (sql === blockedSql) {
        reached.resolve();
        return pending.promise;
      }
      return { rows: [] };
    });
    const next = fakeClient();
    const clients = [first, next];
    const pool = fakePool(async () => clients.shift()!.client);
    const visit = withErasureStatusReadSnapshot(pool, Date.now() + 80, async (client) => {
      await client.query('SELECT erasure status');
      return 'status';
    });

    await reached.promise;
    await expect(visit).rejects.toThrow();
    expect(first.releases[0]).toBeInstanceOf(Error);
    expect(first.queries).toEqual(
      phase === 'begin'
        ? [blockedSql]
        : phase === 'read'
          ? ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', blockedSql]
          : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT erasure status', blockedSql],
    );
    pending.resolve({ rows: [] });

    await expect(
      withErasureStatusReadSnapshot(pool, Date.now() + 500, async (client) => {
        await client.query('SELECT erasure status');
        return 'status';
      }),
    ).resolves.toBe('status');
    expect(next.releases).toEqual([undefined]);
  }
});

test('bounded rollback failure keeps the original source error and discards the client', async () => {
  const rollbackStarted = deferred<void>();
  const source = fakeClient(async (sql) => {
    if (sql === 'ROLLBACK') {
      rollbackStarted.resolve();
      return blocked();
    }
    return { rows: [] };
  });
  const primary = new Error('erasure status source failed');
  const visit = withErasureStatusReadSnapshot(fakePool(async () => source.client), Date.now() + 180, async () => {
    throw primary;
  });

  await rollbackStarted.promise;
  await expect(visit).rejects.toBe(primary);
  expect(source.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(source.releases[0]).toBeInstanceOf(Error);
});

test('expired authority preparation releases the minted operational time', async () => {
  const source = fakeClient(async (sql) => {
    if (sql.includes('COALESCE(NULLIF')) return { rows: [{ at: '2026-11-14T00:00:00.000Z' }] };
    return { rows: [] };
  });
  let captured: AuthoritativeTime | undefined;
  const entered = deferred<void>();
  const preparation = deferred<unknown>();
  const access = {
    async prepare(_actor: Actor, _action: string, _resource: unknown, context: { time: AuthoritativeTime }) {
      captured = context.time;
      entered.resolve();
      return preparation.promise;
    },
    async authorize() {
      return true;
    },
  } as unknown as Access;
  const identity = {
    kind: 'account',
    accountId: '00000000-0000-8000-8000-000000000001',
    authnEpoch: 1,
    clientId: 'erasure-reader',
    requestedBy: null,
  } as Actor;
  const visit = readManagedErasureStatus(
    { pool: fakePool(async () => source.client), access },
    identity,
    { accountId: '00000000-0000-8000-8000-000000000002' },
    { deadline: Date.now() + 60 },
  );

  await entered.promise;
  await expect(visit).rejects.toMatchObject({ code: 'deadline_exceeded' });
  expect(captured).toBeDefined();
  expect(() => authoritativeTimeValue(captured!)).toThrow();
  preparation.resolve(null);
});
