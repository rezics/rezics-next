import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { withBoardReadSnapshot } from '../../src/content/board-read-connection.ts';
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
      return run(sql);
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released();
    },
  } as unknown as PoolClient;
  return { client, statements, releaseWait, releaseError: () => releaseError };
}

function poolFor(connect: () => Promise<PoolClient>): Pool {
  return { connect } as unknown as Pool;
}

const visit = (pool: Pool, deadline: number) =>
  withBoardReadSnapshot(pool, deadline, async (client: AccessClient) => {
    await client.query('SELECT page');
    return 'page';
  });

for (const phase of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT page', 'COMMIT']) {
  test(`a stalled ${phase} discards its connection and the next Board visit succeeds`, async () => {
    const stalled = connection((sql) =>
      sql.startsWith(phase) ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
    );
    const next = connection();
    const clients = [stalled, next];
    const pool = poolFor(async () => clients.shift()!.client);

    await expect(visit(pool, Date.now() + 100)).rejects.toBeInstanceOf(AccessUnavailableError);
    await stalled.releaseWait;
    expect(stalled.statements).toEqual(
      phase === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        ? [phase]
        : phase === 'SELECT page'
          ? ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', phase]
          : ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT page', phase],
    );
    expect(stalled.statements).not.toContain('ROLLBACK');
    expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);

    await expect(visit(pool, Date.now() + 1_000)).resolves.toBe('page');
    expect(next.statements.at(-1)).toBe('COMMIT');
    expect(next.releaseError()).toBeUndefined();
  });
}

test('a checkout that arrives after expiry dispatches no SQL', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const attempt = visit(poolFor(() => checkout), Date.now() + 100);

  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
  expect(late.releaseError()).toBeUndefined();
});

test('a failed Board read keeps its error when rollback expires', async () => {
  const primary = new Error('Board source failed');
  const stalled = connection((sql) =>
    sql === 'ROLLBACK' ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
  );

  await expect(
    withBoardReadSnapshot(poolFor(async () => stalled.client), Date.now() + 120, async () => {
      throw primary;
    }),
  ).rejects.toBe(primary);
  await stalled.releaseWait;
  expect(stalled.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});
