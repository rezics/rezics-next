import { expect, test } from 'bun:test';
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

const valid: Record<keyof typeof CONTENT_EVENTS, unknown> = {
  'com.rezics.content.thread.created.v1': {
    threadId: ids.threadId,
    itemId: ids.itemId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
  },
  'com.rezics.content.post.created.v1': {
    threadId: ids.threadId,
    itemId: ids.postId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
  },
  'com.rezics.content.revision.created.v1': {
    threadId: ids.threadId,
    itemId: ids.postId,
    revisionId: ids.revisionId,
    actorId: ids.actorId,
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
    securityRevision: 3,
  },
  'com.rezics.content.moderation.erasure.v1': {
    threadId: ids.threadId,
    postIds: [ids.postId],
    mediaIds: [ids.mediaId],
  },
  'com.rezics.content.report.created.v1': {
    reportId: ids.reportId,
    targetKind: 'revision',
    targetId: ids.revisionId,
    revisionId: ids.revisionId,
  },
};

test('content event contracts are closed typed ID-only schemas and reject unknown fields or authored body copies', () => {
  expect(Object.keys(CONTENT_EVENTS)).toEqual(Object.keys(valid));

  for (const [type, schema] of Object.entries(CONTENT_EVENTS)) {
    const data = valid[type as keyof typeof CONTENT_EVENTS];
    expect(Value.Check(schema, data)).toBe(true);
    expect(Value.Check(schema, { ...(data as object), unexpected: true })).toBe(false);
    expect(Value.Check(schema, { body: 'authored body' })).toBe(false);
    expect(Value.Check(schema, null)).toBe(false);
  }

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
      securityRevision: 3,
    }),
  ).toBe(false);
});
