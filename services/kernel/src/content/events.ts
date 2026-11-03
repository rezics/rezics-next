import { REVIEW_DISCOVERY_EVENTS } from './review-discovery-events.ts';
import { DISCOVERY_EVENTS, DISCOVERY_OPERATION_EVENTS } from './discovery-events.ts';
import { Type, type Static } from 'typebox';
import { BOARD_EVENTS } from './board-events.ts';
import { MEDIA_EVENTS } from './media-events.ts';
import { MEDIA_IMPORT_EVENTS } from './media-import-events.ts';
import { MEDIA_MODERATION_EVENTS } from './media-moderation-events.ts';
import { MODERATION_EVENTS } from './moderation-events.ts';
import { OPERATION_EVENTS } from './operation-events.ts';
import { REPORT_EVENTS } from './report-events.ts';
import { SOURCE_FENCE_EVENTS } from './source-fence-events.ts';

export const REACTION_KINDS = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;
const reactionKind = Type.Enum(REACTION_KINDS);

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const subjectIds = Type.Array(UUID, { maxItems: 128, uniqueItems: true });
const activityAt = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(?:\\d{3})?Z$' });
const threadIndexFields = {
  placeId: UUID,
  kind: Type.Union([Type.Literal('discussion'), Type.Literal('review')]),
  subjectIds,
  activityAt,
};

/** Closed content event catalogue. Envelope identity and ordering belong to the kernel. */
const editionEvent = Type.Object(
  { editionId: UUID, editionRevision: Type.String({ pattern: '^[1-9][0-9]*$' }) },
  { additionalProperties: false },
);

export const CONTENT_EVENTS = {
  'com.rezics.content.own-drafts.repaired.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.content.board.slow-mode.changed.v1': Type.Object(
    { boardId: UUID, intervalSeconds: Type.Integer({ minimum: 0, maximum: 86400 }) },
    { additionalProperties: false },
  ),
  'com.rezics.content.feed.indexed.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.content.feed.delivered.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.content.feed.erased.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.content.feed.expired.v1': Type.Object({}, { additionalProperties: false }),
  'com.rezics.content.edition.creator-indexed.v1': Type.Object(
    { editionId: UUID, creatorAccountId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.edition.created.v1': editionEvent,
  'com.rezics.content.edition.published.v1': editionEvent,
  'com.rezics.content.edition.unpublished.v1': editionEvent,
  'com.rezics.content.thread.created.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID, ...threadIndexFields },
    { additionalProperties: false },
  ),
  'com.rezics.content.post.created.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID, ...threadIndexFields },
    { additionalProperties: false },
  ),
  'com.rezics.content.post.published.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID, ...threadIndexFields },
    { additionalProperties: false },
  ),
  'com.rezics.content.revision.created.v1': Type.Object(
    {
      threadId: UUID,
      itemId: UUID,
      revisionId: UUID,
      actorId: UUID,
      ...threadIndexFields,
      previousSubjectIds: Type.Optional(subjectIds),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.board.created.v1': Type.Object(
    { boardId: UUID, realmId: Type.Union([UUID, Type.Null()]), conceptId: UUID, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.authored-field.created.v1': Type.Object(
    { id: UUID, subject: UUID, candidate: UUID, authorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.authored-field.erased.v1': Type.Object(
    { id: UUID, subject: UUID, authorId: UUID },
    { additionalProperties: false },
  ),
  ...MEDIA_EVENTS,
  ...MEDIA_IMPORT_EVENTS,
  ...MEDIA_MODERATION_EVENTS,
  ...MODERATION_EVENTS,
  'com.rezics.content.post.restored.v1': Type.Object(
    { postId: UUID, securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
  ...REPORT_EVENTS,
  'com.rezics.content.reaction.changed.v1': Type.Object(
    {
      actorId: UUID,
      targetKind: Type.Union([Type.Literal('thread'), Type.Literal('post'), Type.Literal('subject')]),
      targetId: UUID,
      previousKind: Type.Union([reactionKind, Type.Null()]),
      kind: Type.Union([reactionKind, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  ...OPERATION_EVENTS,
  ...BOARD_EVENTS,
  'com.rezics.content.author-item.projected.v1': Type.Object(
    {
      authorAccountId: UUID,
      itemKind: Type.Union([Type.Literal('thread'), Type.Literal('post')]),
      itemId: UUID,
      sourceEpoch: Type.Integer({ minimum: 1 }),
      sourcePosition: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.subject-thread.projected.v1': Type.Object(
    {
      subjectId: UUID,
      threadId: UUID,
      sourceEpoch: Type.Integer({ minimum: 1 }),
      sourcePosition: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
    { additionalProperties: false },
  ),
  ...SOURCE_FENCE_EVENTS,
  ...REVIEW_DISCOVERY_EVENTS,
  ...DISCOVERY_EVENTS,
  ...DISCOVERY_OPERATION_EVENTS,
} as const;

export type ContentEventType = keyof typeof CONTENT_EVENTS;
export type ContentEventData<T extends ContentEventType> = Static<(typeof CONTENT_EVENTS)[T]>;
