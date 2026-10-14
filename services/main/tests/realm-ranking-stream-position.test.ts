import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  RealmRankingsIncomplete,
  RealmThreadRankingProjection,
  realmRankPage,
} from '../src/modules/rankings/realm-threads.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { WorkReadExpired, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
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
  contentEpoch?: string;
} = {}) {
  return {
    query: async (sql: string, values: unknown[]) => {
      const checksMainCoverage = sql.includes('access.read_realm_thread_rank_cut') && values[9] === '3';
      const checksContentOwner = values[7] === contentEpoch && values[8] === '7';
      return {
        rows: [{
          open: true,
          complete: checksMainCoverage && checksContentOwner
            && (checkpoint.contentEpoch ?? contentEpoch) === values[7]
            && checkpoint.mainSequence !== undefined
            && BigInt(checkpoint.mainSequence) <= BigInt(String(values[9]))
            && checkpoint.contentSequence !== undefined
            && BigInt(checkpoint.contentSequence) <= BigInt(String(values[8])),
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

test('a changed retained ranking expires the cursor without a retryable read failure', async () => {
  await expect(realmRankPage(rankingAccess({ mainSequence: '3', contentSequence: '7' }),
    session(), realm, 'top', 'all', 20,
    { rank: 0, time: '0', placement: realm, revision: '1' }))
    .rejects.toBeInstanceOf(WorkReadExpired);
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

test('A8: established Realm rankings survive same-epoch Main and Content lag', async () => {
  for (const checkpoint of [
    { mainSequence: '2', contentSequence: '7' },
    { mainSequence: '3', contentSequence: '6' },
  ]) {
    for (const sort of ['best', 'top'] as const) {
      expect(await realmRankPage(rankingAccess(checkpoint), session(), realm, sort, 'all', 20))
        .toEqual({ revision: '2', rows: [] });
    }
  }
});

test('A8: pending additions never impose a global Realm ranking gate', async () => {
  const base = rankingAccess({ mainSequence: '2', contentSequence: '6' });
  const access = {
    query: async (sql: string, values: unknown[]) => {
      expect(sql).toContain('access.read_realm_thread_rank_cut');
      expect(sql).not.toContain("WHERE data_epoch=$1 AND kind<>'population'");
      return base.query(sql, values);
    },
  } as unknown as Pool;
  for (const sort of ['best', 'top'] as const) {
    expect(await realmRankPage(access, session(), realm, sort, 'all', 20))
      .toEqual({ revision: '2', rows: [] });
  }
});

test('A8: missing or regressed source checkpoints refuse Realm ranking admission', async () => {
  for (const checkpoint of [
    {},
    { mainSequence: '3', contentSequence: '7', contentEpoch: graphEpoch },
    { mainSequence: '4', contentSequence: '7' },
    { mainSequence: '3', contentSequence: '8' },
  ]) {
    await expect(realmRankPage(
      rankingAccess(checkpoint), session(), realm, 'top', 'all', 20,
    )).rejects.toBeInstanceOf(RealmRankingsIncomplete);
  }
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
