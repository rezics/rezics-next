import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import {
  readSubjectReactionCounts,
  snapshot,
  withReactionCounts,
  withViewerReactions,
  type ContentReadDependencies,
} from '../../src/content/reads.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const id = newId(0x1234);
const partitionNo = partitionOf(routeOf(id)!);

function connection(run: (sql: string) => Promise<unknown> = async () => ({ rows: [] })) {
  const statements: string[] = [];
  let releaseError: Error | undefined;
  let released!: () => void;
  const releaseWait = new Promise<void>((resolve) => (released = resolve));
  const client = {
    query: ((input: string | { text: string }) => {
      const sql = typeof input === 'string' ? input : input.text;
      statements.push(sql);
      return sql.includes('FROM core.partition')
        ? Promise.resolve({
            rows: [{ partitionNo, node: 'local', writeState: 'active', movedTo: null, epoch: 4, position: '27' }],
          })
        : run(sql);
    }) as PoolClient['query'],
    release(error?: Error) {
      releaseError = error;
      released();
    },
  } as unknown as PoolClient;
  return { client, statements, releaseWait, releaseError: () => releaseError };
}

function poolFor(...clients: ReturnType<typeof connection>[]): Pool {
  let index = 0;
  return {
    connect: async () => {
      const next = clients[index++];
      if (!next) throw new Error('Fake pool ran out of clients');
      return next.client;
    },
  } as unknown as Pool;
}

const readDependencies = (pool: Pool) => ({ pool, access: {} as unknown as ContentReadDependencies['access'] });

for (const blocked of ['BEGIN', 'SELECT page', 'COMMIT'] as const) {
  test(`snapshot discards blocked ${blocked} I/O and the next page keeps its anchor`, async () => {
    const first = connection((sql) =>
      (blocked === 'BEGIN' ? sql.startsWith('BEGIN') : sql === blocked)
        ? new Promise<never>(() => {})
        : Promise.resolve({ rows: [] }),
    );
    const retry = connection();
    const pool = poolFor(first, retry);
    const read = (deadline: number) =>
      snapshot(readDependencies(pool), id, { deadline }, async (client) => {
        await client.query('SELECT page');
        return 'page';
      });

    await expect(read(Date.now() + 100)).rejects.toBeInstanceOf(AccessUnavailableError);
    await first.releaseWait;
    expect(first.releaseError()).toBeInstanceOf(AccessUnavailableError);
    expect(first.statements).not.toContain('ROLLBACK');
    const page = await read(Date.now() + 1_000);
    expect(page.value).toBe('page');
    expect(page.anchor).toMatchObject({ epoch: 4, position: 27n });
    expect(retry.statements.at(-1)).toBe('COMMIT');
  });
}

test('a late snapshot checkout dispatches no SQL', async () => {
  let resolveCheckout!: (client: PoolClient) => void;
  const checkout = new Promise<PoolClient>((resolve) => (resolveCheckout = resolve));
  const attempt = snapshot(
    readDependencies({ connect: () => checkout } as unknown as Pool),
    id,
    {
      deadline: Date.now() + 100,
    },
    async () => 'unreachable',
  );

  await expect(attempt).rejects.toBeInstanceOf(AccessUnavailableError);
  const late = connection();
  resolveCheckout(late.client);
  await late.releaseWait;
  expect(late.statements).toEqual([]);
});

test('a stalled rollback preserves its original read error and discards the connection', async () => {
  const original = new Error('page read failed');
  const stalled = connection((sql) =>
    sql === 'ROLLBACK' ? new Promise<never>(() => {}) : Promise.resolve({ rows: [] }),
  );
  await expect(
    snapshot(readDependencies(poolFor(stalled)), id, { deadline: Date.now() + 100 }, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await stalled.releaseWait;
  expect(stalled.statements.at(-1)).toBe('ROLLBACK');
  expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
});

test('viewer, count and subject reaction reads discard stalled queries and retry', async () => {
  const actor = {
    kind: 'account',
    accountId: id,
    clientId: 'reads-deadline',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  } as const;
  const reads = [
    (dependencies: ContentReadDependencies, deadline: number) =>
      withViewerReactions(dependencies, actor, [{ id }], deadline),
    (dependencies: ContentReadDependencies, deadline: number) => withReactionCounts(dependencies, [{ id }], deadline),
    (dependencies: ContentReadDependencies, deadline: number) =>
      readSubjectReactionCounts({ pool: dependencies.pool }, [id], deadline),
  ];

  for (const read of reads) {
    const stalled = connection(() => new Promise<never>(() => {}));
    const retry = connection();
    const pool = poolFor(stalled, retry);
    await expect(
      read(readDependencies(pool) as unknown as ContentReadDependencies, Date.now() + 100),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
    await stalled.releaseWait;
    expect(stalled.releaseError()).toBeInstanceOf(AccessUnavailableError);
    await read(readDependencies(pool) as unknown as ContentReadDependencies, Date.now() + 1_000);
    expect(retry.statements).toHaveLength(1);
  }
});
