import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createLibraryAccessPorts } from '../../src/access/adapters/library.ts';
import { bindLibraryAccess } from '../../src/library/domain-binding.ts';
import { withFollowDiscoveryReadConnection } from '../../src/library/follow-discovery-read-connection.ts';

bindLibraryAccess(createLibraryAccessPorts());

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let release!: (error?: Error) => void;
  const released = new Promise<Error | undefined>((resolve) => (release = resolve));
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    }) as unknown as PoolClient['query'],
    release,
  } as unknown as PoolClient;
  return { client, statements, released };
}

const pool = (connect: () => Promise<PoolClient>) => ({ connect }) as unknown as Pool;

test('Follow snapshots bound checkout, discard uncertain phases, and commit successful reads', async () => {
  let resolveLate!: (client: PoolClient) => void;
  const late = connection(),
    checkout = new Promise<PoolClient>((resolve) => (resolveLate = resolve));
  const read = withFollowDiscoveryReadConnection(pool(() => checkout), Date.now() + 20, async () => 'unreachable');
  await expect(read).rejects.toThrow();
  resolveLate(late.client);
  expect(late.statements).toEqual([]);
  expect(await late.released).toBeInstanceOf(Error);

  for (const phase of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT private', 'COMMIT']) {
    let finish!: (result: unknown) => void;
    const pending = connection((sql) =>
      sql === phase ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ rows: [] }),
    );
    const next = connection();
    let checkouts = 0;
    const readPool = pool(async () => (checkouts++ === 0 ? pending.client : next.client));
    await expect(
      withFollowDiscoveryReadConnection(readPool, Date.now() + 20, async (client) => {
        await client.query('SELECT private');
        return null;
      }),
    ).rejects.toThrow();
    expect(await pending.released).toBeInstanceOf(Error);
    expect(pending.statements).not.toContain('ROLLBACK');
    finish({ rows: [] });
    if (phase === 'SELECT private') {
      expect(
        await withFollowDiscoveryReadConnection(readPool, Date.now() + 5_000, async (client) => {
          await client.query('SELECT authorized');
          return 'current';
        }),
      ).toBe('current');
      expect(await next.released).toBeUndefined();
    }
  }

  const primary = new Error('Follow access failed'),
    cleanup = connection((sql) =>
      sql === 'ROLLBACK' ? Promise.reject(new Error('rollback failed')) : Promise.resolve({ rows: [] }),
    );
  await expect(
    withFollowDiscoveryReadConnection(pool(async () => cleanup.client), Date.now() + 5_000, async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  expect(await cleanup.released).toBeInstanceOf(Error);

  const successful = connection();
  expect(
    await withFollowDiscoveryReadConnection(pool(async () => successful.client), Date.now() + 5_000, async (client) => {
      await client.query('SELECT private');
      return 'current';
    }),
  ).toBe('current');
  expect(successful.statements).toEqual([
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SELECT private',
    'COMMIT',
  ]);
  expect(await successful.released).toBeUndefined();
});
