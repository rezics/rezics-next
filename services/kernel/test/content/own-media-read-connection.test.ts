import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../../src/access/contract/errors.ts';
import { withOwnMediaReadSnapshot } from '../../src/content/own-media-read-connection.ts';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture(blocked?: string, checkout?: Deferred<PoolClient>) {
  const statements: string[] = [];
  const pendingQuery = deferred<unknown>();
  const released = deferred<void>();
  let releaseError: Error | undefined;
  const client = {
    query: ((input: string | QueryConfig) => {
      const statement = typeof input === 'string' ? input : input.text;
      statements.push(statement);
      return statement === blocked ? pendingQuery.promise : Promise.resolve({ rows: [] });
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released.resolve();
    },
  } as unknown as PoolClient;
  const pool = {
    connect: () => checkout?.promise ?? Promise.resolve(client),
  } as unknown as Pool;
  return { pool, client, statements, pendingQuery, released: released.promise, releaseError: () => releaseError };
}

test('bounds checkout and every transaction control without rolling back expired native work', async () => {
  const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
  const phases = [
    { blocked: undefined, expected: [] },
    { blocked: begin, expected: [begin] },
    { blocked: 'SELECT 1', expected: [begin, 'SELECT 1'] },
    { blocked: 'COMMIT', expected: [begin, 'SELECT 1', 'COMMIT'] },
  ];
  for (const phase of phases) {
    const checkout = phase.blocked === undefined ? deferred<PoolClient>() : undefined;
    const state = fixture(phase.blocked, checkout);
    const pending = withOwnMediaReadSnapshot(state.pool, Date.now() + 30, async (client) => {
      await client.query('SELECT 1');
      return 'complete';
    });
    await expect(pending).rejects.toBeInstanceOf(AccessUnavailableError);
    checkout?.resolve(state.client);
    await state.released;
    expect(state.statements).toEqual(phase.expected);
    if (checkout) expect(state.releaseError()).toBeUndefined();
    else expect(state.releaseError()).toBeInstanceOf(Error);
    state.pendingQuery.resolve({ rows: [] });
  }
});

test('preserves the successful read result and commits the repeatable-read snapshot', async () => {
  const state = fixture();
  const result = await withOwnMediaReadSnapshot(state.pool, Date.now() + 1_000, async (client) => {
    await client.query('SELECT 1');
    return { entries: ['media'] };
  });
  expect(result).toEqual({ entries: ['media'] });
  expect(state.statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', 'COMMIT']);
  await state.released;
  expect(state.releaseError()).toBeUndefined();
});
