import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { contentConnection, contentSessionClient, withContentSession } from './connection.ts';

function sessionPool() {
  const releases: Array<Error | boolean | undefined> = [];
  let checkouts = 0;
  const client = { query: async () => ({ rows: [] }),
    release: (error?: Error | boolean) => { releases.push(error); } } as unknown as PoolClient;
  const pool = { connect: async () => { checkouts++; return client; } } as unknown as Pool;
  return { pool, client, releases, checkouts: () => checkouts };
}

test('an import session lends only its own pool connection and nested locks do not release it', async () => {
  const { pool, client, releases, checkouts } = sessionPool();
  const other = sessionPool();
  expect(contentConnection(pool)).toBe(pool);
  await withContentSession(pool, async outer => {
    expect(outer).toBe(client);
    expect(contentConnection(pool)).toBe(client);
    expect(contentConnection(other.pool)).toBe(other.pool);
    await withContentSession(pool, async inner => { expect(inner).toBe(outer); });
    expect(checkouts()).toBe(1);
    expect(releases).toEqual([]);
  });
  expect(contentSessionClient(pool)).toBeUndefined();
  expect(releases).toEqual([false]);
});

test('a failed or cancelled import destroys its connection and abandoned work cannot borrow it', async () => {
  const { pool, releases } = sessionPool();
  let lateRead: () => Promise<unknown> = async () => undefined;
  const error = new Error('cancelled');
  await expect(withContentSession(pool, async () => {
    let resume!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const abandoned = wait.then(() => contentConnection(pool));
    // Attach before rejection to avoid an unhandled rejection in this test.
    lateRead = () => { resume(); return abandoned; };
    throw error;
  })).rejects.toBe(error);
  expect(releases).toEqual([true]);
  await expect(lateRead()).rejects.toThrow('Content session has ended');
});

test('parallel imports do not inherit one another’s session', async () => {
  let count = 0;
  const releases: number[] = [];
  const pool = { connect: async () => {
    const id = ++count;
    return { release: () => releases.push(id) } as unknown as PoolClient;
  } } as unknown as Pool;
  let resume!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const first = withContentSession(pool, async client => { await wait; expect(contentConnection(pool)).toBe(client); });
  await withContentSession(pool, async () => { expect(count).toBe(2); });
  resume();
  await first;
  expect(releases).toEqual([2, 1]);
});

test('cancellation disposes a held connection before an abandoned query settles', async () => {
  const { pool, releases } = sessionPool();
  const lease = new AbortController();
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const running = withContentSession(pool, async () => {
    lease.abort(new Error('lease lost'));
    expect(releases).toEqual([true]);
    await blocked;
  }, lease.signal);
  resume();
  await running;
  expect(releases).toEqual([true]);
});
