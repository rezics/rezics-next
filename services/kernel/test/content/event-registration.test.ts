import { afterAll, expect, expectTypeOf, test } from 'bun:test';
import pg from 'pg';
import { newId } from '../../src/route/route.ts';
import { runCommand, type CommandEvent } from '../../src/command/command.ts';
import { CONTENT_EVENTS, type ContentEventData, type ContentEventType } from '../../src/content/events.ts';
import { createPool } from '../../src/database/pool.ts';
import { registerEffects } from '../../src/events/effects.ts';
import { EVENT_TYPES, readBatch, type Envelope } from '../../src/events/log.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

const actorId = crypto.randomUUID();
const threadId = crypto.randomUUID();
const itemId = crypto.randomUUID();
const revisionId = crypto.randomUUID();
const mediaId = crypto.randomUUID();
const containerId = crypto.randomUUID();
const reportId = crypto.randomUUID();
const authored = { threadId, itemId, revisionId, actorId };
const threadIndex = {
  placeId: containerId,
  kind: 'discussion' as const,
  subjectIds: [itemId],
  activityAt: '2026-10-27T00:00:00.000Z',
};
const media = { mediaId, containerId };
const fixtures = {
  'com.rezics.content.feed.indexed.v1': {},
  'com.rezics.content.feed.delivered.v1': {},
  'com.rezics.content.feed.erased.v1': {},
  'com.rezics.content.feed.expired.v1': {},
  'com.rezics.content.edition.creator-indexed.v1': { editionId: itemId, creatorAccountId: actorId },
  'com.rezics.content.edition.created.v1': { editionId: itemId, editionRevision: '1' },
  'com.rezics.content.edition.published.v1': { editionId: itemId, editionRevision: '2' },
  'com.rezics.content.edition.unpublished.v1': { editionId: itemId, editionRevision: '3' },
  'com.rezics.content.realm-discovery.prepared.v1': { route: 1234, intent: 'a'.repeat(64), generation: '1' },
  'com.rezics.content.realm-discovery.outcome.v1': { route: 1234, intent: 'a'.repeat(64), generation: '1' },
  'com.rezics.content.realm-discovery.changed.v1': {
    realmId: newId(4321),
    realmEpoch: '1',
    spaceId: newId(4321),
    boardId: newId(4321),
    threadId: newId(1234),
    sourceRoute: 1234,
    creationDay: '2026-10-30',
    sourceVersion: '1',
    contributing: true,
    change: 1,
  },
  'com.rezics.content.thread.created.v1': { ...authored, ...threadIndex },
  'com.rezics.content.post.created.v1': { ...authored, ...threadIndex },
  'com.rezics.content.revision.created.v1': {
    ...authored,
    ...threadIndex,
    previousSubjectIds: [itemId],
  },
  'com.rezics.content.board.created.v1': {
    boardId: containerId,
    realmId: crypto.randomUUID(),
    conceptId: crypto.randomUUID(),
    actorId,
  },
  'com.rezics.content.authored-field.created.v1': {
    id: revisionId,
    subject: itemId,
    candidate: threadId,
    authorId: actorId,
  },
  'com.rezics.content.authored-field.erased.v1': {
    id: revisionId,
    subject: itemId,
    authorId: actorId,
  },
  'com.rezics.content.media.reserved.v1': { ...media, actorId },
  'com.rezics.content.media.uploaded.v1': { ...media, actorId },
  'com.rezics.content.media.available.v1': media,
  'com.rezics.content.media.rejected.v1': { ...media, decisionId: revisionId },
  'com.rezics.content.media.erased.v1': media,
  'com.rezics.content.media.collection-pending.v1': media,
  'com.rezics.content.media.collected.v1': media,
  'com.rezics.content.media.import-requested.v1': { mediaId },
  'com.rezics.content.media.taken-down.v1': { mediaId, securityRevision: '9223372036854775807' },
  'com.rezics.content.moderation.appeal-created.v1': { appealId: itemId },
  'com.rezics.content.moderation.appeal-resolved.v1': { appealId: itemId },
  'com.rezics.content.moderation.takedown.v1': {
    targetKind: 'post',
    targetId: itemId,
    securityRevision: '9223372036854775807',
  },
  'com.rezics.content.moderation.restored.v1': {
    targetKind: 'post',
    targetId: itemId,
    securityRevision: '9223372036854775807',
  },
  'com.rezics.content.post.erased.v1': { postId: itemId, securityRevision: '9223372036854775807' },
  'com.rezics.content.moderation.erasure.v1': { threadId, postIds: [itemId], mediaIds: [mediaId] },
  'com.rezics.content.post.restored.v1': { postId: itemId, securityRevision: '9223372036854775807' },
  'com.rezics.content.report.resolved.v1': { reportId },
  'com.rezics.content.report.created.v1': { reportId, targetKind: 'post', targetId: itemId, revisionId },
  'com.rezics.content.catalogue-report.projected.v1': { reportId },
  'com.rezics.content.report-target.projected.v1': { reportId, targetKind: 'post', targetId: itemId },
  'com.rezics.content.reaction.changed.v1': {
    actorId,
    targetKind: 'post',
    targetId: itemId,
    previousKind: 'upvote',
    kind: 'like',
  },
  'com.rezics.content.author-erasure.requested.v1': { operationId: revisionId, threadId, authorId: actorId },
  'com.rezics.content.board-thread.projected.v1': {
    boardId: containerId,
    threadId,
    sourceEpoch: 1,
    sourcePosition: '9223372036854775807',
  },
  'com.rezics.content.author-item.projected.v1': {
    authorAccountId: actorId,
    itemKind: 'thread',
    itemId: threadId,
    sourceEpoch: 1,
    sourcePosition: '9223372036854775807',
  },
  'com.rezics.content.subject-thread.projected.v1': {
    subjectId: itemId,
    threadId,
    sourceEpoch: 1,
    sourcePosition: '9223372036854775807',
  },
  'com.rezics.content.source_fence.taken_down.v1': {
    route: 1234,
    source: 'catalog',
    external_id: 'external-subject',
    field_group: 'cover',
    securityRevision: '9223372036854775807',
  },
} satisfies { [T in ContentEventType]: ContentEventData<T> };
const entries = Object.entries(fixtures);
let nextPartition = 1400;
const consumer = 'content_registration';
const append = (partition: number, events: CommandEvent[]) =>
  runCommand(pool, { partition }, async () => ({ value: null, events }));

async function insertOutboxEvent(partition: number, event: CommandEvent): Promise<void> {
  const result = await admin.query(
    `WITH next AS (
       UPDATE core.partition
       SET position = position + 1
       WHERE partition_no = $1
       RETURNING epoch, position
     )
     INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT $1, next.position, 0, 1, next.epoch, $2, $3, $4, $5::jsonb
     FROM next
     RETURNING position`,
    [partition, crypto.randomUUID(), event.type, event.subject ?? null, JSON.stringify(event.data)],
  );
  if (result.rowCount !== 1) throw new Error(`Partition ${partition} is unavailable for malformed event setup`);
}

async function checkpoint(partition: number) {
  const { rows } = await admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer = $1 AND partition_no = $2',
    [consumer, partition],
  );
  return BigInt(rows[0]!.position);
}

test.each(entries)('native command log/readBatch accepts %s', async (type, data) => {
  const partition = nextPartition++;
  const written = await append(partition, [{ type, subject: threadId, data }]);
  const seen: Envelope[] = [];
  expect(
    await readBatch(pool, {
      consumer,
      partition,
      apply: async (envelopes) => void seen.push(...envelopes),
    }),
  ).toEqual({ status: 'read', envelopes: 1, position: written.position });
  expect<unknown>(seen).toEqual([
    {
      partition,
      epoch: written.epoch,
      position: written.position,
      events: [
        {
          specversion: '1.0',
          id: expect.any(String),
          source: `urn:rezics:log:${partition}.${written.epoch}`,
          type,
          subject: threadId,
          time: expect.any(String),
          datacontenttype: 'application/json',
          sequence: written.position.toString().padStart(19, '0'),
          data,
        },
      ],
    },
  ]);
  expect(await checkpoint(partition)).toBe(written.position);
});

test('reaction event types retain the closed kinds and nullable transitions', () => {
  type ReactionKind = 'upvote' | 'downvote' | 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
  expectTypeOf<ContentEventData<'com.rezics.content.reaction.changed.v1'>>().toEqualTypeOf<{
    actorId: string;
    targetKind: 'thread' | 'post' | 'subject';
    targetId: string;
    previousKind: ReactionKind | null;
    kind: ReactionKind | null;
  }>();
});

test('native registerEffects accepts every closed content event', () => {
  expect(() =>
    registerEffects(entries.map(([type], index) => ({ name: `content_${index}`, types: [type], run: async () => {} }))),
  ).not.toThrow();
});

test('the ESM catalogue shares the module schema values', async () => {
  const again = await import('../../src/events/log.ts');
  expect(again.EVENT_TYPES).toBe(EVENT_TYPES);
  expect(Object.keys(CONTENT_EVENTS)).toEqual(Object.keys(fixtures));
  for (const [type, schema] of Object.entries(CONTENT_EVENTS)) {
    expect(Reflect.get(EVENT_TYPES, type)).toBe(schema);
  }
});

const unknownTypes = ['com.rezics.content.unknown.v1', 'content.thread.created.v1', 'toString'];
test.each(unknownTypes)('native registerEffects still refuses %s', (type) => {
  expect(() => registerEffects([{ name: 'unknown', types: [type], run: async () => {} }])).toThrow(RangeError);
});

const poisons: { event: CommandEvent; reason: 'unknown_type' | 'invalid_data' }[] = [
  ...unknownTypes.map((type) => ({ event: { type, data: authored }, reason: 'unknown_type' as const })),
  ...entries.map(([type, data]) => ({
    event: { type, data: { ...data, body: 'must not enter an event payload' } },
    reason: 'invalid_data' as const,
  })),
  ...[1, '0', '01', '-1', '1.0'].map((securityRevision) => ({
    event: {
      type: 'com.rezics.content.moderation.takedown.v1',
      data: { targetKind: 'post', targetId: itemId, securityRevision },
    },
    reason: 'invalid_data' as const,
  })),
];

test.each(poisons)(
  'native reader refuses $reason: $event without advancing its checkpoint',
  async ({ event, reason }) => {
    const partition = nextPartition++;
    const valid = { type: 'com.rezics.subject.created.v1', data: { id: actorId } };
    const before = await append(partition, [valid]);
    const apply = async () => {};
    expect(await readBatch(pool, { consumer, partition, apply })).toEqual({
      status: 'read',
      envelopes: 1,
      position: before.position,
    });
    await insertOutboxEvent(partition, event);
    await append(partition, [valid]);
    let applied = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await readBatch(pool, {
          consumer,
          partition,
          apply: async () => void (applied = true),
        }),
      ).toEqual({ status: 'stopped', reason, envelopes: 0, position: before.position });
      expect(await checkpoint(partition)).toBe(before.position);
    }
    expect(applied).toBe(false);
  },
);
