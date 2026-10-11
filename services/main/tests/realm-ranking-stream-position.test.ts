import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  RealmRankingsIncomplete,
  RealmThreadRankingProjection,
  realmRankPage,
} from '../src/modules/rankings/realm-threads.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { FeedCheckpoint } from '../src/modules/feed/store.ts';

const graphEpoch = '00000000-0000-4000-8000-000000000010';
const contentEpoch = '00000000-0000-4000-8000-000000000011';
const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000020';

function session(options: {
  contentSequence?: string;
  relayPosition?: { streamScope: string; dataEpoch: string; sequence: string } | null;
} = {}): WorkReadSession {
  return {
    position: { dataEpoch: graphEpoch, sequence: '100' },
    deps: {
      relayPosition: {
        read: async () => options.relayPosition ?? {
          streamScope: MAIN_RELAY_STREAM_SCOPE,
          dataEpoch: graphEpoch,
          sequence: '3',
        },
      },
      realmReplyThreads: {
        rankingContent: {
          query: async () => ({ rows: [{
            data_epoch: contentEpoch,
            sequence: options.contentSequence ?? '7',
          }] }),
        },
      },
    },
  } as unknown as WorkReadSession;
}

function rankingAccess(checkpoint: {
  mainSequence?: string;
  contentSequence?: string;
  pendingEffects?: boolean;
} = {}) {
  return {
    query: async (sql: string, values: unknown[]) => {
      const checksMainCoverage = sql.includes('c.sequence=$10::numeric') && values[9] === '3';
      const checksContentOwner = sql.includes('c.content_sequence=$9::bigint')
        && values[7] === contentEpoch && values[8] === '7';
      const checksPendingEffects = sql.includes('AND NOT realm_thread_indexed')
        && sql.includes('access.realm_thread_dirty');
      return {
        rows: [{
          open: true,
          complete: checksMainCoverage && checksContentOwner && checksPendingEffects
            && checkpoint.mainSequence !== undefined && checkpoint.mainSequence === values[9]
            && checkpoint.contentSequence !== undefined && checkpoint.contentSequence === values[8]
            && !checkpoint.pendingEffects,
          revision: '2',
          rows: [],
        }],
      };
    },
  } as unknown as Pool;
}

test('A8: completed Realm ranking at Main stream 3 survives graph diagnostic position 100', async () => {
  const result = await realmRankPage(
    rankingAccess({ mainSequence: '3', contentSequence: '7' }),
    session(),
    realm,
    'top',
    'all',
    20,
  );
  expect(result).toEqual({ revision: '2', rows: [] });
});

test('A8: foreign Main stream scope or epoch refuses Realm ranking admission', async () => {
  for (const relayPosition of [
    { streamScope: 'urn:rezics:stream:foreign', dataEpoch: graphEpoch, sequence: '3' },
    { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: contentEpoch, sequence: '3' },
  ]) {
    let queried = false;
    const access = {
      query: async () => {
        queried = true;
        return { rows: [] };
      },
    } as unknown as Pool;
    await expect(realmRankPage(access, session({ relayPosition }), realm, 'top', 'all', 20))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(queried).toBe(false);
  }
});

test('A8: actual Main lag and Content lag still refuse Realm ranking admission', async () => {
  await expect(realmRankPage(
    rankingAccess({ mainSequence: '2', contentSequence: '7' }),
    session(), realm, 'top', 'all', 20,
  )).rejects.toBeInstanceOf(RealmRankingsIncomplete);

  await expect(realmRankPage(
    rankingAccess({ mainSequence: '3', contentSequence: '6' }),
    session(), realm, 'top', 'all', 20,
  )).rejects.toBeInstanceOf(RealmRankingsIncomplete);
});

test('A8: pending Main or Content effects still refuse Realm ranking admission', async () => {
  await expect(realmRankPage(
    rankingAccess({ mainSequence: '3', contentSequence: '7', pendingEffects: true }),
    session(), realm, 'top', 'all', 20,
  )).rejects.toBeInstanceOf(RealmRankingsIncomplete);
});

test('A8: Realm relay event replay selects only Main stream events', async () => {
  const checkpoint = {
    sequence: '2',
    after_event: '￿',
    content_epoch: contentEpoch,
    content_sequence: '7',
  };
  let eventQuery: { sql: string; values: unknown[] } | undefined;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT open FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('FROM access.realm_thread_checkpoint') && sql.includes('FOR UPDATE'))
      return { rows: [checkpoint] };
    if (sql.includes('FROM access.realm_thread_checkpoint')) return { rows: [checkpoint] };
    if (sql.includes('FROM access.feed_item')) return { rows: [] };
    if (sql.includes('FROM access.realm_thread_dirty')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release: () => undefined };
  const access = {
    query,
    connect: async () => client,
  } as unknown as Pool;
  const relay = {
    query: async (sql: string, values: unknown[]) => {
      eventQuery = { sql, values };
      return { rows: [] };
    },
  } as unknown as Pool;
  const readSession = {
    position: { dataEpoch: graphEpoch, sequence: '100' },
    deps: {
      content: {},
      realmReplyThreads: {
        rankingContent: {
          query: async () => ({ rows: [{ data_epoch: contentEpoch, sequence: '7' }] }),
        },
      },
    },
  } as unknown as WorkReadSession;
  const feed: FeedCheckpoint = {
    data_epoch: graphEpoch,
    sequence: '3',
    after_id: '￿',
    revision: 'revision',
    rebuild_epoch: null,
    rebuild_after: '',
    review_sequence: '0',
  };

  await new RealmThreadRankingProjection(access, relay).tick(readSession, feed, '3');

  expect(eventQuery?.sql).toContain('FROM relay.delivered_event WHERE stream_scope=$1 AND data_epoch=$2');
  expect(eventQuery?.values).toEqual([MAIN_RELAY_STREAM_SCOPE, graphEpoch, '3', '2', '￿', 20]);
});
