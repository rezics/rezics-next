import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { mediaParentSnapshot } from '../../src/content/media-parent.ts';
import type { AccessClient } from '../../src/request/access.ts';

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let released!: () => void;
  const releaseWait = new Promise<void>((resolve) => (released = resolve));
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      if (sql.includes('FROM core.partition')) {
        return run(sql).then((result) => {
          const rows = (result as { rows?: unknown[] } | null)?.rows;
          return rows?.length
            ? result
            : {
                rows: [{ partitionNo: 0, node: 'local', writeState: 'active', movedTo: null, epoch: 1, position: '0' }],
              };
        });
      }
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

for (const blocked of ['BEGIN', 'partition', 'parent', 'COMMIT'] as const) {
  test(`deadline during ${blocked} snapshot stage discards the client for a successful retry`, async () => {
    const first = connection((sql) => {
      const isBlocked =
        (blocked === 'BEGIN' && sql.startsWith('BEGIN')) ||
        (blocked === 'partition' && sql.includes('FROM core.partition')) ||
        (blocked === 'parent' && sql === 'SELECT parent') ||
        (blocked === 'COMMIT' && sql === 'COMMIT');
      return isBlocked ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] });
    });
    const retry = connection();
    const pool = poolFor(first, retry);
    const work = (client: AccessClient) => client.query('SELECT parent').then(() => 'current disclosure');

    await expect(mediaParentSnapshot(pool, 0x1234, Date.now() + 50, work)).rejects.toBeInstanceOf(
      AccessUnavailableError,
    );
    await first.releaseWait;
    expect(first.releaseError()).toBeInstanceOf(AccessUnavailableError);
    expect(first.statements).not.toContain('ROLLBACK');
    await expect(mediaParentSnapshot(pool, 0x1234, Date.now() + 1000, work)).resolves.toBe('current disclosure');
    expect(retry.statements.at(-1)).toBe('COMMIT');
  });
}

test('an expired checkout dispatches no SQL when it arrives late', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const pool = { connect: () => checkout } as unknown as Pool;
  const attempt = mediaParentSnapshot(pool, 0x1234, Date.now() + 50, async () => 'unreachable');

  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeInstanceOf(AccessUnavailableError);
});

test('bounded rollback preserves the original callback error and discards a stalled client', async () => {
  const original = new Error('parent read failed');
  const stalled = connection((sql) =>
    sql === 'ROLLBACK' ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
  );

  await expect(
    mediaParentSnapshot(poolFor(stalled), 0x1234, Date.now() + 50, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await stalled.releaseWait;
  expect(stalled.statements.at(-1)).toBe('ROLLBACK');
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});
