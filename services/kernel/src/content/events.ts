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

/** Closed content event catalogue. Envelope identity and ordering belong to the kernel. */
export const CONTENT_EVENTS = {
  'com.rezics.content.thread.created.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.post.created.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.revision.created.v1': Type.Object(
    { threadId: UUID, itemId: UUID, revisionId: UUID, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.board.created.v1': Type.Object(
    { boardId: UUID, realmId: UUID, conceptId: UUID, actorId: UUID },
    { additionalProperties: false },
  ),
  ...MEDIA_EVENTS,
  ...MEDIA_IMPORT_EVENTS,
  ...MEDIA_MODERATION_EVENTS,
  ...MODERATION_EVENTS,
  ...REPORT_EVENTS,
  'com.rezics.content.reaction.changed.v1': Type.Object(
    {
      actorId: UUID,
      targetKind: Type.Union([Type.Literal('thread'), Type.Literal('post')]),
      targetId: UUID,
      previousKind: Type.Union([reactionKind, Type.Null()]),
      kind: Type.Union([reactionKind, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  ...OPERATION_EVENTS,
  ...BOARD_EVENTS,
  ...SOURCE_FENCE_EVENTS,
} as const;

export type ContentEventType = keyof typeof CONTENT_EVENTS;
export type ContentEventData<T extends ContentEventType> = Static<(typeof CONTENT_EVENTS)[T]>;
