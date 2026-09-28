import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { NotificationProducer } from '../src/modules/notification-producers/producer.ts';
import { feedNotificationSubjectReader } from '../src/modules/notification-producers/feed-subjects.ts';
import { FeedStore } from '../src/modules/feed/store.ts';
import type { NotificationEvent } from '../src/modules/notification/store.ts';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const native = (last: number) => `https://rezics.com/id/${id(last)}`;

async function produced(kind: 'chapter_published' | 'feed_post_vote', stale = false) {
  const events: NotificationEvent[] = [];
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM access.notification_producer_cursor')) return { rows: [{ position: '0' }] };
    if (sql.includes('FROM access.notification_producer_event')) return { rows: [{ position: '1',
      event_id: id(1), kind }] };
    return { rows: [] };
  }, release: () => {} };
  const access = { connect: async () => client, query: async (sql: string) => {
    if (sql.includes('FROM access.chapter_notification_event')) return { rows: [{ activity: native(2),
      work: native(3), author: native(4), content_revision: `urn:rezics:content:revision:${id(5)}` }] };
    if (sql.includes('FROM access.feed_post_vote_event')) return { rows: stale ? [] : [{ target: native(2),
      author: native(4), voter: native(6), voter_principal: id(7), vote_revision: id(8) }] };
    if (sql.includes('FROM access.follow f')) return { rows: [{ id: id(9) }, { id: id(10) }] };
    if (sql.includes('FROM access.representation')) return { rows: kind === 'chapter_published'
      ? [{ id: id(9) }] : [{ id: id(10) }] };
    throw new Error(`Unexpected Access read: ${sql}`);
  } } as unknown as Pool;
  const producer = new NotificationProducer(access, null, {} as Pool, {} as never,
    { enqueue: async (event: NotificationEvent) => { events.push(event); return []; } } as never, null);
  await producer.runAccessOnce();
  return events;
}

test('a followed chapter notifies Work and author followers once, excluding the author', async () => {
  expect(await produced('chapter_published')).toMatchObject([{ purpose: 'subscription',
    topic: 'followed-chapter', recipients: [id(10)], subject: { ref: native(2) } }]);
});

test('a current upvote notifies the post author; a superseded vote emits nothing', async () => {
  expect(await produced('feed_post_vote')).toMatchObject([{ purpose: 'social',
    topic: 'post-vote', recipients: [id(10)], subject: { ref: native(2), revision: id(8) } }]);
  expect(await produced('feed_post_vote', true)).toEqual([]);
});

test('a former Work follower cannot read a queued chapter notification', async () => {
  let graphReads = 0;
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.chapter_notification_event')) return { rows: [{ work: native(3),
      author: native(4), content_revision: `urn:rezics:content:revision:${id(5)}` }] };
    if (sql.includes('FROM access.follow f')) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected Access read: ${sql}`);
  } } as unknown as Pool;
  const env = { fuseki: { query: async () => { graphReads++; return { results: { bindings: [] } }; } } } as never;
  const reader = feedNotificationSubjectReader(access, env, {} as never, {} as never);
  expect(await reader.resolve({ owner: 'graph', ref: native(2),
    revision: `urn:rezics:content:revision:${id(5)}`, principalId: id(10),
    disclosureBasis: 'followed-chapter-v1' })).toEqual({ status: 'undisclosed' });
  expect(graphReads).toBe(0);
});

test('a current follower sees only a chapter whose exact Content revision remains public', async () => {
  const revision = `urn:rezics:content:revision:${id(5)}`;
  const access = { query: async (sql: string) => {
    if (sql.includes('FROM access.chapter_notification_event')) return { rows: [{ work: native(3),
      author: native(4), content_revision: revision }] };
    if (sql.includes('FROM access.follow f')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM access.reader_review')) return { rows: [] };
    throw new Error(`Unexpected Access read: ${sql}`);
  } } as unknown as Pool;
  const bind = (value: string) => ({ type: 'literal', value });
  let sourceReads = 0;
  const env = { lineage: { dataEpoch: id(21), routingEpoch: '0' }, fuseki: {
    query: async (sql: string) => {
      if (sql.includes('ASK')) return { boolean: true };
      if (sql.includes('SELECT ?title')) return { results: { bindings: [{ title: bind('The Work') }] } };
      if (sql.includes('SELECT DISTINCT ?id ?sequence ?kind')) {
        sourceReads++;
        return { results: { bindings: [{ id: bind(native(2)), sequence: bind('1'),
          kind: bind('contribution'), target: bind(native(7)), work: bind(native(3)),
          occurrence: bind(native(8)), contentTarget: bind(native(7)),
          contentRevision: bind(revision), language: bind('en') }] } };
      }
      throw new Error(`Unexpected graph read: ${sql}`);
    } } } as never;
  const content = { readExactBatch: async () => [{ status: 'available', revisionId: id(5),
    reference: { resourceId: native(7), provenance: { kind: 'admitted-original-contribution-v1',
      author: native(4) } }, body: { body: 'Chapter body' } }] } as never;
  const reader = feedNotificationSubjectReader(access, env, content, {} as never);
  expect(await reader.resolve({ owner: 'graph', ref: native(2), revision,
    principalId: id(10), disclosureBasis: 'followed-chapter-v1' })).toMatchObject({
    status: 'available', subject: { fields: { linkTarget: native(3), title: 'The Work' } } });
  expect(sourceReads).toBe(2);
});

test('an upvote appends its notification fact and producer event in the vote transaction', async () => {
  const statements: string[] = [];
  let appendKind = '';
  const client = { query: async (sql: string, args?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('access.append_notification_producer_event')) appendKind = String(args?.[0]);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('FROM access.principal WHERE account_issuer')) return { rows: [{ id: id(11) }] };
    if (sql.includes('FROM access.agent_provision')) return { rows: [{ provision_id: id(12) }] };
    if (sql.includes('SELECT * FROM access.feed_checkpoint')) return { rows: [{ data_epoch: 'epoch' }] };
    if (sql.includes('SELECT score, occurred_at FROM access.feed_item')) {
      return { rows: [{ score: 3, occurred_at: new Date('2026-09-28T00:00:00Z') }] };
    }
    return { rows: [], rowCount: 1 };
  }, release: () => {} };
  const store = new FeedStore({ connect: async () => client } as unknown as Pool);
  const result = await store.vote({ issuer: 'account', subject: 'voter', emailVerified: true }, native(2),
    'epoch', { profile: 'feed-vote-command-v1', actingSubject: native(6), value: 1,
      expectedRevision: null }, 'vote:1', async () => ({ actor: native(4), work: native(3) }));
  expect(result.score).toBe(4);
  expect(statements.some(sql => sql.includes('INSERT INTO access.feed_post_vote_event'))).toBe(true);
  expect(appendKind).toBe('feed_post_vote');
  expect(statements.at(-1)).toBe('COMMIT');
});

test('chapter projection appends a durable notification event with the newly projected post', async () => {
  const statements: string[] = [];
  let appendKind = '';
  const checkpoint = { data_epoch: 'epoch', sequence: '0', after_id: '', revision: id(20),
    rebuild_epoch: null, rebuild_after: '', review_sequence: '0' };
  const client = { query: async (sql: string, args?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('SELECT * FROM access.feed_checkpoint')) return { rows: [checkpoint] };
    if (sql.includes('SELECT 1 FROM access.feed_item')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM access.feed_item')) return { rows: [], rowCount: 0 };
    if (sql.includes('access.append_notification_producer_event')) appendKind = String(args?.[0]);
    return { rows: [], rowCount: 1 };
  }, release: () => {} };
  const store = new FeedStore({ connect: async () => client } as unknown as Pool);
  await store.advance(checkpoint, '1', [{ id: native(2), sequence: '1', kind: 'contribution',
    work: native(3), actor: native(4), occurrence: native(5), contentRevision: `urn:rezics:content:revision:${id(6)}`,
    groupKind: 'chapter' }], new Map([['1', new Date('2026-09-28T00:00:00Z')]]));
  expect(statements.some(sql => sql.includes('INSERT INTO access.chapter_notification_event'))).toBe(true);
  expect(appendKind).toBe('chapter_published');
  expect(statements.at(-1)).toBe('COMMIT');
});
