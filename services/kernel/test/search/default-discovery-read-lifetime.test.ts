import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { withBoundedReadOnlyTransaction } from '../../src/database/pool.ts';
import { readAdmittedDiscoveryPage } from '../../src/search/default-discovery.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function client(
  query: (config: QueryConfig) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  release: (error?: Error | boolean) => void = () => {},
): PoolClient {
  return {
    query(input: QueryConfig | string, values?: unknown[]) {
      return query(typeof input === 'string' ? { text: input, ...(values === undefined ? {} : { values }) } : input);
    },
    release,
  } as unknown as PoolClient;
}

const pool = (connect: () => Promise<PoolClient>) => ({ connect }) as unknown as Pool;

test('pool wait and late checkout use the Search deadline without dispatching enrichment SQL', async () => {
  const checkout = deferred<PoolClient>();
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  let enrichment = 0;
  const late = client(
    (config) => {
      statements.push(config.text ?? '');
      return { rows: [] };
    },
    (error) => released.resolve(error),
  );
  const deadline = Date.now() + 50;
  const visit = withBoundedReadOnlyTransaction(
    pool(() => checkout.promise),
    deadline,
    async (connection) => {
      enrichment += 1;
      await connection.query('SELECT enrichment');
    },
    { deadlineError: () => new SearchUnavailableError('Search discovery read deadline expired') },
  );

  await expect(visit).rejects.toBeInstanceOf(SearchUnavailableError);
  expect(Date.now()).toBeLessThan(deadline + 300);
  checkout.resolve(late);
  expect(await released.promise).toBeUndefined();
  expect(enrichment).toBe(0);
  expect(statements).toEqual([]);
}, 5_000);

test('a stalled rollback retires the snapshot client and preserves the first read failure', async () => {
  const readFailure = new Error('figure read failed');
  const released = deferred<Error | boolean | undefined>();
  const statements: string[] = [];
  const visit = withBoundedReadOnlyTransaction(
    pool(async () =>
      client(
        (config) => {
          const sql = config.text ?? '';
          statements.push(sql);
          if (sql === 'SELECT figures') return Promise.reject(readFailure);
          if (sql === 'ROLLBACK') return new Promise(() => {});
          return { rows: [] };
        },
        (error) => released.resolve(error),
      ),
    ),
    Date.now() + 60,
    async (connection) => {
      await connection.query('SELECT figures');
    },
    { deadlineError: () => new SearchUnavailableError('Search discovery read deadline expired') },
  );

  await expect(visit).rejects.toBe(readFailure);
  expect(await released.promise).toBe(readFailure);
  expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT figures', 'ROLLBACK']);
}, 5_000);

test('a current retained page keeps its useful facts and WorkContext through finish and close', async () => {
  const page = {
    hits: [
      {
        facts: { 'schema:genre': [{ kind: 'text', value: 'fiction' }] },
        workContext: {
          state: 'current',
          subjectId: 'book-1',
          type: { id: 'schema:Book', labels: { en: 'Book' } },
          kind: 'work',
          creators: { state: 'empty' },
          relations: { state: 'empty' },
          dates: { state: 'empty' },
        },
      },
    ],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-14T00:00:00.000Z',
  } as unknown as DiscoveryPage;
  let finished = 0;
  let closed = 0;
  const current = await readAdmittedDiscoveryPage(
    {
      search: async () => page,
      finish: async () => {
        finished += 1;
      },
      close: async () => {
        closed += 1;
      },
    },
    async (value) => ({ page: value, viewerCurrent: true }),
  );

  expect(current.hits[0]).toMatchObject({
    facts: { 'schema:genre': [{ kind: 'text', value: 'fiction' }] },
    workContext: {
      state: 'current',
      subjectId: 'book-1',
      type: { id: 'schema:Book', labels: { en: 'Book' } },
      kind: 'work',
      creators: { state: 'empty' },
      relations: { state: 'empty' },
      dates: { state: 'empty' },
    },
  });
  expect([finished, closed]).toEqual([1, 1]);
});
