import { expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError } from '../src/access/unavailable.ts';
import { CommandUnavailableError } from '../src/command/command.ts';
import {
  withErasureStatusReadConnection,
  withErasureStatusReadSnapshot,
} from '../src/access/erasure-status-read-connection.ts';
import {
  withManagedAdviceReadConnection,
  withManagedAdviceReadSnapshot,
} from '../src/access/managed-advice-read-connection.ts';
import {
  withManagementReadConnection,
  withManagementReadSnapshot,
} from '../src/access/management-read-connection.ts';
import { withViewerActionsReadSnapshot } from '../src/access/viewer-actions-read-connection.ts';
import { withAuthorReadConnection } from '../src/content/author-read-connection.ts';
import { withFeedReadConnection } from '../src/content/feed-read-connection.ts';
import { moderationReadSnapshot } from '../src/content/moderation-read-connection.ts';
import { withReportReadConnection } from '../src/content/report-read-connection.ts';
import { withOwnDraftReadConnection } from '../src/content/own-drafts-index-read-connection.ts';
import { withOwnMediaReadSnapshot } from '../src/content/own-media-read-connection.ts';
import { withSubjectDiscussionReadSnapshot } from '../src/content/subject-discussion-read-connection.ts';
import { withOwnRealmsReadSnapshot } from '../src/community/own-realms-read-connection.ts';
import { withSourceRatingReadConnection } from '../src/rating/source-rating-read-connection.ts';
import {
  withCollectionReadConnection,
  withCollectionReadSnapshot,
} from '../src/library/collection-read-connection.ts';
import { withCopyReadConnection } from '../src/library/copy-read-connection.ts';
import { withEntryPersonalReadSnapshot } from '../src/library/entry-personal-read-connection.ts';
import { withFollowDiscoveryReadConnection } from '../src/library/follow-discovery-read-connection.ts';
import { withQueryAccounting, type QueryAccounting } from '../src/database/pool.ts';

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const select = 'SELECT matrix';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function connection(partitionState: 'active' | 'moved' = 'active') {
  const queries: QueryConfig[] = [];
  const releases: (Error | boolean | undefined)[] = [];
  const released = deferred<void>();
  let checkouts = 0;
  const client = {
    query(input: QueryConfig | string, values?: unknown[]) {
      const config =
        typeof input === 'string' ? { text: input, ...(values === undefined ? {} : { values }) } : input;
      queries.push(config);
      const text = config.text ?? '';
      if (text.includes('FROM core.partition'))
        return Promise.resolve({
          rows: [
            {
              partitionNo: 1,
              node: 'node-a',
              writeState: partitionState,
              movedTo: partitionState === 'moved' ? 'node-b' : null,
              epoch: 3,
              position: '9',
            },
          ],
        });
      return Promise.resolve({ rows: [] });
    },
    release(error?: Error | boolean) {
      releases.push(error);
      released.resolve();
    },
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      checkouts += 1;
      return client;
    },
  } as unknown as Pool;
  return { pool, queries, releases, released: released.promise, checkouts: () => checkouts };
}

const adapters: ReadonlyArray<{
  name: string;
  snapshot: boolean;
  localTimeout?: boolean;
  partitionAnchor?: boolean;
  run(pool: Pool, deadline: number): Promise<unknown>;
}> = [
  {
    name: 'erasure connection',
    snapshot: false,
    run: (pool, deadline) =>
      withErasureStatusReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'erasure connection';
      }),
  },
  {
    name: 'erasure snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withErasureStatusReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'erasure snapshot';
      }),
  },
  {
    name: 'managed advice connection',
    snapshot: false,
    run: (pool, deadline) =>
      withManagedAdviceReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'managed advice connection';
      }),
  },
  {
    name: 'managed advice snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withManagedAdviceReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'managed advice snapshot';
      }),
  },
  {
    name: 'management connection',
    snapshot: false,
    run: (pool, deadline) =>
      withManagementReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'management connection';
      }),
  },
  {
    name: 'management snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withManagementReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'management snapshot';
      }),
  },
  {
    name: 'viewer actions snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withViewerActionsReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'viewer actions snapshot';
      }),
  },
  {
    name: 'author snapshot',
    snapshot: true,
    localTimeout: true,
    run: (pool, deadline) =>
      withAuthorReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'author snapshot';
      }),
  },
  {
    name: 'feed snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withFeedReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'feed snapshot';
      }),
  },
  {
    name: 'moderation snapshot',
    snapshot: true,
    partitionAnchor: true,
    run: (pool, deadline) =>
      moderationReadSnapshot(pool, 1, deadline, async (client) => {
        await client.query(select);
        return 'moderation snapshot';
      }),
  },
  {
    name: 'report snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withReportReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'report snapshot';
      }),
  },
  {
    name: 'own drafts snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withOwnDraftReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'own drafts snapshot';
      }),
  },
  {
    name: 'own media snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withOwnMediaReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'own media snapshot';
      }),
  },
  {
    name: 'Subject discussion snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withSubjectDiscussionReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'Subject discussion snapshot';
      }),
  },
  {
    name: 'own Realms snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withOwnRealmsReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'own Realms snapshot';
      }),
  },
  {
    name: 'Rating plain read',
    snapshot: false,
    run: (pool, deadline) =>
      withSourceRatingReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'Rating plain read';
      }),
  },
  {
    name: 'Rating optional snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withSourceRatingReadConnection(
        pool,
        deadline,
        async (client) => {
          await client.query(select);
          return 'Rating optional snapshot';
        },
        { repeatableRead: true },
      ),
  },
  {
    name: 'Collection plain read',
    snapshot: false,
    run: (pool, deadline) =>
      withCollectionReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'Collection plain read';
      }),
  },
  {
    name: 'Collection snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withCollectionReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'Collection snapshot';
      }),
  },
  {
    name: 'Copy plain read',
    snapshot: false,
    run: (pool, deadline) =>
      withCopyReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'Copy plain read';
      }),
  },
  {
    name: 'Copy optional snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withCopyReadConnection(
        pool,
        deadline,
        async (client) => {
          await client.query(select);
          return 'Copy optional snapshot';
        },
        { transaction: true },
      ),
  },
  {
    name: 'entry personal snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withEntryPersonalReadSnapshot(pool, deadline, async (client) => {
        await client.query(select);
        return 'entry personal snapshot';
      }),
  },
  {
    name: 'Follow discovery snapshot',
    snapshot: true,
    run: (pool, deadline) =>
      withFollowDiscoveryReadConnection(pool, deadline, async (client) => {
        await client.query(select);
        return 'Follow discovery snapshot';
      }),
  },
];

test('settled read adapters preserve plain and snapshot modes with one accounting pass', async () => {
  const physicalQueries: string[] = [];
  const accountedQueries: string[] = [];
  let accountedConnections = 0;
  const accounting: QueryAccounting = {
    query(sql, _operands, dispatch) {
      accountedQueries.push(sql);
      return dispatch();
    },
    connection(dispatch) {
      accountedConnections += 1;
      return dispatch();
    },
  };

  await withQueryAccounting(accounting, async () => {
    for (const adapter of adapters) {
      const current = connection();
      const value = await adapter.run(current.pool, Date.now() + 2_000);
      const statements = current.queries.map((query) => query.text ?? '');
      physicalQueries.push(...statements);

      expect(current.checkouts()).toBe(1);
      expect(current.releases).toEqual([undefined]);
      expect(current.queries.every((query) => typeof query.query_timeout === 'number' && query.query_timeout > 0)).toBe(true);
      if (adapter.snapshot) {
        expect(statements[0]).toBe(begin);
        expect(statements.at(-1)).toBe('COMMIT');
        expect(statements).toContain(select);
      } else {
        expect(statements).toEqual([select]);
      }
      if (adapter.localTimeout) expect(statements).toContain("SET LOCAL statement_timeout = '3000ms'");
      if (adapter.partitionAnchor) expect(statements.some((sql) => sql.includes('FROM core.partition'))).toBe(true);
      expect(statements).not.toContain('ROLLBACK');
      if (adapter.name === 'moderation snapshot') {
        expect(value).toMatchObject({ value: adapter.name, anchor: { partition: 1, epoch: 3, position: 9n } });
      } else {
        expect(value).toBe(adapter.name);
      }
    }
  });

  expect(accountedConnections).toBe(adapters.length);
  expect(accountedQueries).toEqual(physicalQueries);
});

test('adapter options preserve owner deadline and settled PostgreSQL errors', async () => {
  let checkouts = 0;
  const expiredPool = {
    async connect() {
      checkouts += 1;
      throw new Error('expired checkout must not start');
    },
  } as unknown as Pool;
  const expired = await withManagedAdviceReadConnection(expiredPool, Date.now() - 1, async () => 'unused').catch(
    (error: unknown) => error,
  );
  expect(expired).toBeInstanceOf(AccessUnavailableError);
  expect(checkouts).toBe(0);

  const late = connection();
  const healthy = connection();
  const lateCheckout = deferred<PoolClient>();
  let checkoutCount = 0;
  const recoveryPool = {
    connect: () => {
      if (checkoutCount++ === 0) return lateCheckout.promise;
      return healthy.pool.connect();
    },
  } as unknown as Pool;
  const pending = withManagementReadConnection(recoveryPool, Date.now() + 20, async (client) => {
    await client.query(select);
    return 'too late';
  });
  await expect(pending).rejects.toBeInstanceOf(AccessUnavailableError);
  lateCheckout.resolve(await late.pool.connect());
  await late.released;
  expect(late.queries).toEqual([]);
  expect(late.releases).toEqual([undefined]);
  await expect(
    withManagementReadConnection(recoveryPool, Date.now() + 2_000, async (client) => {
      await client.query('SELECT healthy');
      return 'current';
    }),
  ).resolves.toBe('current');
  expect(healthy.queries.map((query) => query.text ?? '')).toEqual(['SELECT healthy']);

  const serverFailure = Object.assign(new Error('settled source failure'), { code: '23505', severity: 'ERROR' });
  const statements: string[] = [];
  let releaseError: Error | boolean | undefined;
  const pool = {
    async connect() {
      return {
        async query(input: QueryConfig | string) {
          const sql = typeof input === 'string' ? input : input.text ?? '';
          statements.push(sql);
          if (sql === 'SELECT rejected') throw serverFailure;
          return { rows: [] };
        },
        release(error?: Error | boolean) {
          releaseError = error;
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const settled = await withReportReadConnection(pool, Date.now() + 2_000, async (client) => {
    await client.query('SELECT rejected');
  }).catch((error: unknown) => error);
  expect(settled).toBe(serverFailure);
  expect(statements).toEqual([begin, 'SELECT rejected', 'ROLLBACK']);
  expect(releaseError).toBeUndefined();

  const movedPool = connection('moved');
  const moved = await moderationReadSnapshot(movedPool.pool, 1, Date.now() + 2_000, async () => 'unused').catch(
    (error: unknown) => error,
  );
  expect(moved).toBeInstanceOf(CommandUnavailableError);
  expect(movedPool.queries.map((query) => query.text ?? '')).toContain('ROLLBACK');

  const feedPool = connection();
  const ownerFailure = new CommandUnavailableError('moved', 1, 'node-b');
  const feedFailure = await withFeedReadConnection(feedPool.pool, Date.now() + 2_000, async () => {
    throw ownerFailure;
  }).catch((error: unknown) => error);
  expect(feedFailure).toBe(ownerFailure);
  expect(feedPool.queries.map((query) => query.text ?? '')).toEqual([begin, 'ROLLBACK']);
});
