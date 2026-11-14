import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { moderationReadSnapshot } from '../../src/content/moderation-read-connection.ts';
import type { AccessClient } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const id = newId(0x1234);
const route = routeOf(id)!;
const partitionNo = partitionOf(route);

function connection(
  run: (sql: string) => Promise<unknown> = async (sql) =>
    sql.includes('FROM core.partition')
      ? {
          rows: [{ partitionNo, node: 'local', writeState: 'active', movedTo: null, epoch: 4, position: '27' }],
        }
      : { rows: [] },
) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let released!: () => void;
  const releaseWait = new Promise<void>((resolve) => (released = resolve));
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return run(sql);
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released();
    },
  } as unknown as PoolClient;
  return { client, statements, releaseWait, releaseError: () => releaseError };
}

type Connection = ReturnType<typeof connection>;

function poolFor(...clients: Connection[]): Pool {
  let index = 0;
  return {
    connect: async () => {
      const next = clients[index++];
      if (!next) throw new Error('Fake pool ran out of clients');
      return next.client;
    },
  } as unknown as Pool;
}

const read = (client: AccessClient) => client.query('SELECT source').then(() => 'current source');

for (const blocked of ['BEGIN', 'partition', 'SELECT source', 'COMMIT']) {
  test(`a deadline during ${blocked} discards the client without queuing rollback and the next snapshot keeps its anchor`, async () => {
    const stalled = connection((sql) => {
      const isBlocked =
        blocked === 'BEGIN'
          ? sql.startsWith('BEGIN')
          : blocked === 'partition'
            ? sql.includes('FROM core.partition')
            : sql === blocked;
      if (isBlocked) return new Promise<never>(() => {});
      return sql.includes('FROM core.partition')
        ? Promise.resolve({
            rows: [{ partitionNo, node: 'local', writeState: 'active', movedTo: null, epoch: 4, position: '27' }],
          })
        : Promise.resolve({ rows: [] });
    });
    const retry = connection();
    const pool = poolFor(stalled, retry);

    await expect(moderationReadSnapshot(pool, route, Date.now() + 100, read)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    await stalled.releaseWait;
    expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
    expect(stalled.statements).not.toContain('ROLLBACK');

    const current = await moderationReadSnapshot(pool, route, Date.now() + 1_000, read);
    expect(current.value).toBe('current source');
    expect(current.anchor).toEqual({ partition: partitionNo, epoch: 4, position: 27n });
    expect(retry.statements.at(-1)).toBe('COMMIT');
  });
}

test('a checkout that arrives after expiry dispatches no SQL', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const attempt = moderationReadSnapshot({ connect: () => checkout } as unknown as Pool, route, Date.now() + 100, read);

  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
});

test('rollback stays inside the deadline and keeps the original read error', async () => {
  const original = new Error('moderation source read failed');
  const stalled = connection((sql) =>
    sql === 'ROLLBACK' ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
  );

  await expect(
    moderationReadSnapshot(poolFor(stalled), route, Date.now() + 100, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await stalled.releaseWait;
  expect(stalled.statements.at(-1)).toBe('ROLLBACK');
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});
