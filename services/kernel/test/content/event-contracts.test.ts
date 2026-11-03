import { expect, test } from 'bun:test';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { CONTENT_EVENTS } from '../../src/content/events.ts';

const ids = {
  actorId: '11111111-1111-4111-8111-111111111111',
  containerId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
  mediaId: '44444444-4444-4444-8444-444444444444',
  postId: '55555555-5555-4555-8555-555555555555',
  reportId: '66666666-6666-4666-8666-666666666666',
  revisionId: '77777777-7777-4777-8777-777777777777',
  threadId: '88888888-8888-4888-8888-888888888888',
};

const threadIndex = {
  placeId: ids.containerId,
  kind: 'discussion' as const,
  subjectIds: [ids.itemId],
  activityAt: '2026-10-27T00:00:00.000Z',
};

const valid = {
  'com.rezics.content.thread.created.v1': {
    threadId: ids.threadId,
    itemId: ids.itemId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
    ...threadIndex,
  },
  'com.rezics.content.post.created.v1': {
    threadId: ids.threadId,
    itemId: ids.postId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
    ...threadIndex,
  },
  'com.rezics.content.post.published.v1': {
    threadId: ids.threadId, itemId: ids.postId, revisionId: ids.revisionId, actorId: ids.actorId, ...threadIndex,
  },
  'com.rezics.content.revision.created.v1': {
    threadId: ids.threadId,
    itemId: ids.postId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
    ...threadIndex,
    previousSubjectIds: [ids.itemId],
  },
  'com.rezics.content.media.reserved.v1': { mediaId: ids.mediaId, containerId: ids.containerId, actorId: ids.actorId },
  'com.rezics.content.media.uploaded.v1': { mediaId: ids.mediaId, containerId: ids.containerId, actorId: ids.actorId },
  'com.rezics.content.media.available.v1': { mediaId: ids.mediaId, containerId: ids.containerId },
  'com.rezics.content.media.rejected.v1': {
    mediaId: ids.mediaId,
    containerId: ids.containerId,
    decisionId: ids.revisionId,
  },
  'com.rezics.content.media.erased.v1': { mediaId: ids.mediaId, containerId: ids.containerId },
  'com.rezics.content.media.collected.v1': { mediaId: ids.mediaId, containerId: ids.containerId },
  'com.rezics.content.moderation.takedown.v1': {
    targetKind: 'post',
    targetId: ids.postId,
    securityRevision: '3',
  },
  'com.rezics.content.moderation.erasure.v1': {
    threadId: ids.threadId,
    postIds: [ids.postId],
    mediaIds: [ids.mediaId],
  },
  'com.rezics.content.report.created.v1': {
    reportId: ids.reportId,
    targetKind: 'post',
    targetId: ids.postId,
    revisionId: ids.revisionId,
  },
} satisfies Partial<Record<keyof typeof CONTENT_EVENTS, unknown>>;

function assertOriginalContracts(catalogue: Record<string, TSchema>): void {
  for (const [type, data] of Object.entries(valid)) {
    expect(Object.hasOwn(catalogue, type)).toBe(true);
    const schema = catalogue[type]!;
    expect(Value.Check(schema, data)).toBe(true);
    expect(Value.Check(schema, { ...data, unexpected: true })).toBe(false);
    expect(Value.Check(schema, { body: 'authored body' })).toBe(false);
    for (const field of ['body', 'title', 'snippet']) {
      expect(Value.Check(schema, { ...data, [field]: 'authored bytes' })).toBe(false);
    }
    expect(Value.Check(schema, null)).toBe(false);
  }
}

test('content event contracts are closed typed ID-only schemas and reject unknown fields or authored body copies', () => {
  assertOriginalContracts(CONTENT_EVENTS);

  expect(
    Value.Check(CONTENT_EVENTS['com.rezics.content.thread.created.v1'], {
      threadId: ids.threadId,
      itemId: ids.itemId,
      revisionId: ids.revisionId,
      actorId: ids.actorId,
      title: 'authored title',
    }),
  ).toBe(false);
  expect(
    Value.Check(CONTENT_EVENTS['com.rezics.content.media.rejected.v1'], {
      mediaId: ids.mediaId,
      containerId: ids.containerId,
      decisionId: 'not-an-id',
    }),
  ).toBe(false);
  expect(
    Value.Check(CONTENT_EVENTS['com.rezics.content.moderation.takedown.v1'], {
      targetKind: 'account',
      targetId: ids.postId,
      securityRevision: '3',
    }),
  ).toBe(false);

  const takedown = CONTENT_EVENTS['com.rezics.content.moderation.takedown.v1'];
  for (const securityRevision of ['1', '9223372036854775807', '999999999999999999999999999999999999']) {
    expect(Value.Check(takedown, { targetKind: 'board', targetId: ids.containerId, securityRevision })).toBe(true);
  }
  for (const securityRevision of ['0', '01', '-1', '1.0', '', 1]) {
    expect(Value.Check(takedown, { targetKind: 'post', targetId: ids.postId, securityRevision })).toBe(false);
  }
  expect(Value.Check(takedown, { targetKind: 'media', targetId: ids.mediaId, securityRevision: '1' })).toBe(false);

  const report = CONTENT_EVENTS['com.rezics.content.report.created.v1'];
  for (const targetKind of ['board', 'thread', 'post']) {
    expect(Value.Check(report, { reportId: ids.reportId, targetKind, targetId: ids.itemId })).toBe(true);
  }
  for (const targetKind of ['revision', 'media', 'account']) {
    expect(Value.Check(report, { reportId: ids.reportId, targetKind, targetId: ids.itemId })).toBe(false);
  }
});

test('a synthetic closed additive event coexists with every required original contract', () => {
  const type = 'com.rezics.content.media.collection-pending.v1';
  const schema = Type.Object(
    { mediaId: Type.Literal(ids.mediaId), containerId: Type.Literal(ids.containerId) },
    { additionalProperties: false },
  );
  const extended = { ...CONTENT_EVENTS, [type]: schema };
  assertOriginalContracts(extended);

  const data = { mediaId: ids.mediaId, containerId: ids.containerId };
  expect(Value.Check(extended[type], data)).toBe(true);
  expect(Value.Check(schema, { ...data, unexpected: true })).toBe(false);
  for (const field of ['body', 'title', 'snippet']) {
    expect(Value.Check(schema, { ...data, [field]: 'authored bytes' })).toBe(false);
  }
  expect(Value.Check(schema, { body: 'authored body' })).toBe(false);
  expect(Value.Check(schema, null)).toBe(false);
  expect(Value.Check(schema, { mediaId: ids.mediaId })).toBe(false);
  expect(Value.Check(schema, { ...data, mediaId: 'not-an-id' })).toBe(false);

  for (const requiredType of Object.keys(valid)) {
    const missing: Record<string, TSchema> = { ...extended };
    delete missing[requiredType];
    expect(() => assertOriginalContracts(missing)).toThrow();
  }
  for (const unknownType of ['com.rezics.content.unknown.v1', 'content.thread.created.v1', 'toString']) {
    expect(Object.hasOwn(extended, unknownType)).toBe(false);
  }
});

test('first-publication evidence requires the exact revision and closed index fields', () => {
  const schema = CONTENT_EVENTS['com.rezics.content.post.published.v1'];
  const data = valid['com.rezics.content.post.published.v1'];
  for (const field of Object.keys(data)) {
    const missing: Record<string, unknown> = { ...data };
    delete missing[field];
    expect(Value.Check(schema, missing)).toBe(false);
  }
  for (const [field, invalid] of [
    ['revisionId', 'not-an-id'],
    ['actorId', null],
    ['kind', 'post'],
    ['subjectIds', [ids.itemId, ids.itemId]],
    ['activityAt', 'yesterday'],
    ['previousSubjectIds', []],
    ['visibility', 'published'],
  ])
    expect(Value.Check(schema, { ...data, [field as string]: invalid })).toBe(false);
});
