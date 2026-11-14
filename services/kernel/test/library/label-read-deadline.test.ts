import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createLibraryAccessPorts } from '../../src/access/adapters/library.ts';
import { bindLibraryAccess } from '../../src/library/domain-binding.ts';
import { withLabelReadConnection } from '../../src/library/label-read-connection.ts';

bindLibraryAccess(createLibraryAccessPorts());

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [],
    releases: (Error | undefined)[] = [];
  return {
    statements,
    releases,
    client: {
      query: ((input: string | { text: string }) => {
        const sql = typeof input === 'string' ? input : input.text;
        statements.push(sql);
        return run(sql);
      }) as unknown as PoolClient['query'],
      release: (error?: Error) => releases.push(error),
    } as unknown as PoolClient,
  };
}

const pool = (client: PoolClient) => ({ connect: async () => client }) as unknown as Pool;

test('late checkout sends no SQL and releases its client', async () => {
  const originalNow = Date.now;
  let now = originalNow(),
    resolveClient!: (client: PoolClient) => void,
    start!: () => void;
  const deadline = now + 5_000,
    late = connection(),
    checkoutStarted = new Promise<void>((resolve) => (start = resolve)),
    waiting = new Promise<PoolClient>((resolve) => (resolveClient = resolve));
  Date.now = () => now;
  try {
    const read = withLabelReadConnection(
      { connect: () => (start(), waiting) } as unknown as Pool,
      deadline,
      'REPEATABLE READ',
      async () => 'unreachable',
    );
    await checkoutStarted;
    now = deadline + 1;
    resolveClient(late.client);
    await expect(read).rejects.toThrow();
    expect(late.statements).toEqual([]);
    expect(late.releases[0]).toBeInstanceOf(Error);
  } finally {
    Date.now = originalNow;
  }
});

test('uncertain phases discard clients, preserve primary failures, and allow the next read', async () => {
  for (const phase of ['BEGIN ISOLATION LEVEL REPEATABLE READ', 'SELECT private', 'COMMIT']) {
    let finish!: (result: unknown) => void;
    const timedOut = phase === 'SELECT private',
      failure = new Error(phase),
      broken = connection((sql) =>
        sql !== phase
          ? Promise.resolve({ rows: [] })
          : timedOut
            ? new Promise((resolve) => (finish = resolve))
            : Promise.reject(failure),
      ),
      read = withLabelReadConnection(
        pool(broken.client),
        Date.now() + (timedOut ? 30 : 5_000),
        'REPEATABLE READ',
        async (client) => {
          await client.query('SELECT private');
          return null;
        },
      ).catch((error: unknown) => error);
    const error = await read;
    if (timedOut) finish({ rows: [] });
    else expect(error).toBe(failure);
    expect(broken.statements).not.toContain('ROLLBACK');
    expect(broken.releases[0]).toBeInstanceOf(Error);
  }

  const primary = new Error('owner admission denied'),
    rollback = new Error('rollback failed'),
    cleanup = connection((sql) => (sql === 'ROLLBACK' ? Promise.reject(rollback) : Promise.resolve({ rows: [] })));
  const error = await withLabelReadConnection(pool(cleanup.client), Date.now() + 5_000, 'REPEATABLE READ', async () => {
    throw primary;
  }).catch((reason: unknown) => reason);
  expect(error).toBe(primary);
  expect(cleanup.releases).toEqual([rollback]);

  const next = connection();
  const result = await withLabelReadConnection(
    pool(next.client),
    Date.now() + 5_000,
    'REPEATABLE READ',
    async (client) => {
      await client.query('SELECT current private catalogue');
      return ['current private label'];
    },
  );
  expect(result).toEqual(['current private label']);
  expect(next.statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
  expect(next.statements.at(-1)).toBe('COMMIT');
});
