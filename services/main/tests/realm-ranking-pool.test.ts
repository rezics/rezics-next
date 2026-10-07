import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { NestedPoolCheckoutError } from '../src/infrastructure/pg-pool.ts';
import { FeedRefreshWorker } from '../src/modules/feed/refresh.ts';
import { FeedStore, type FeedCheckpoint } from '../src/modules/feed/store.ts';
import {
  RealmThreadRankingProjection,
  REALM_RANK_COST,
} from '../src/modules/rankings/realm-threads.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const epoch = '11111111-1111-4111-8111-111111111111';
const ownerEpoch = '22222222-2222-4222-8222-222222222222';
const reply = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const feed: FeedCheckpoint = {
  data_epoch: epoch,
  sequence: '1',
  after_id: '￿',
  revision: 'revision',
  rebuild_epoch: null,
  rebuild_after: '',
  review_sequence: '0',
};

function fixture(options: { contentSequence?: string; moved?: boolean } = {}) {
  let held = false,
    releases = 0;
  const calls: { sql: string; values: unknown; held: boolean }[] = [];
  const checkpoint = {
    sequence: '1',
    after_event: '￿',
    content_epoch: ownerEpoch,
    content_sequence: '1',
  };
  const query = async (sql: string, values?: unknown) => {
    calls.push({ sql, values, held });
    if (sql.includes('SELECT open FROM access.recovery_fence'))
      return { rows: [{ open: true }], rowCount: 1 };
    if (sql.includes('SELECT * FROM access.feed_checkpoint')) return { rows: [feed], rowCount: 1 };
    if (sql.includes('FROM access.feed_target_checkpoint'))
      return { rows: [{ sequence: '0', after_event: '￿' }], rowCount: 1 };
    if (sql.includes('FROM access.realm_thread_checkpoint'))
      return {
        rows: [
          {
            ...checkpoint,
            ...(options.moved && sql.includes('FOR UPDATE') ? { content_sequence: '2' } : {}),
          },
        ],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query,
    release: () => {
      held = false;
      releases++;
    },
  } as unknown as PoolClient;
  const access = {
    connect: async () => {
      if (held) throw new NestedPoolCheckoutError();
      held = true;
      return client;
    },
    query: async (sql: string, values?: unknown) => {
      if (held) throw new NestedPoolCheckoutError();
      return query(sql, values);
    },
  } as unknown as Pool;
  const content = {
    query: async (sql: string) =>
      sql.includes('content.owner_control')
        ? { rows: [{ data_epoch: ownerEpoch, sequence: options.contentSequence ?? '1' }] }
        : { rows: [{ sequence: '2', reply, resource: null }] },
  } as unknown as Pool;
  const relay = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const deps = {
    access: {
      assertRecoveryOpen: async () => {
        if (held) throw new NestedPoolCheckoutError();
      },
    },
    environment: {
      lineage: { dataEpoch: epoch, routingEpoch: ownerEpoch },
      fuseki: {
        query: async () => ({
          results: { bindings: [{ epoch: { value: epoch }, sequence: { value: '1' } }] },
        }),
      },
    },
    content: {},
    realmReplyThreads: { rankingContent: content },
    relayPosition: { read: async () => ({ dataEpoch: epoch, sequence: '1' }) },
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(
    deps,
    new Request('http://main.internal/fixture'),
    {},
    { dataEpoch: epoch, sequence: '1' },
  );
  return { access, relay, deps, session, calls, released: () => releases, held: () => held };
}

test('feed refresh releases initialization and sibling target clients before the Realm ranking turn', async () => {
  const f = fixture();
  expect(await new FeedRefreshWorker(f.deps, new FeedStore(f.access), f.relay).tick()).toBe(
    'advanced',
  );
  const ranking = f.calls.find((call) =>
    call.sql.includes('INSERT INTO access.realm_thread_checkpoint'),
  );
  expect(ranking?.held).toBe(false);
  expect(f.released()).toBe(2);
  expect(f.held()).toBe(false);
  expect(
    f.calls.find((call) => call.sql.includes('DELETE FROM access.realm_thread_order'))?.values,
  ).toEqual([REALM_RANK_COST.expirationBatch]);
});

test('Content changes dirty only the exact reply and advance the Realm checkpoint in the same Access transaction', async () => {
  const f = fixture({ contentSequence: '2' });
  expect(await new RealmThreadRankingProjection(f.access, f.relay).tick(f.session, feed, '1')).toBe(
    true,
  );
  const invalidation = f.calls.filter((call) =>
    call.sql.includes('INSERT INTO access.realm_thread_dirty'),
  );
  expect(invalidation).toHaveLength(1);
  expect(invalidation[0]).toMatchObject({ values: [epoch, 'reply', reply], held: true });
  expect(f.calls.find((call) => call.sql.includes('SET content_sequence=$2'))).toMatchObject({
    values: [epoch, '2'],
    held: true,
  });
  expect(f.calls.at(-1)?.sql).toBe('COMMIT');
  expect(f.released()).toBe(1);
  expect(f.held()).toBe(false);
});

test('a moved Realm source cut rolls back before invalidation and releases the only Access client', async () => {
  const f = fixture({ contentSequence: '2', moved: true });
  await expect(
    new RealmThreadRankingProjection(f.access, f.relay).tick(f.session, feed, '1'),
  ).rejects.toBeInstanceOf(WorkReadMoved);
  expect(f.calls.some((call) => call.sql.includes('INSERT INTO access.realm_thread_dirty'))).toBe(
    false,
  );
  expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
  expect(f.released()).toBe(1);
  expect(f.held()).toBe(false);
  await expect(f.access.query('SELECT 1')).resolves.toBeDefined();
});
