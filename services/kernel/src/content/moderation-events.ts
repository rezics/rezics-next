import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

export const MODERATION_EVENTS = {
  'com.rezics.content.moderation.takedown.v1': Type.Object(
    {
      targetKind: Type.Union([Type.Literal('board'), Type.Literal('thread'), Type.Literal('post')]),
      targetId: UUID,
      // Keep the database bigint value lossless across JSON and JavaScript.
      securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.moderation.restored.v1': Type.Object(
    {
      targetKind: Type.Union([Type.Literal('thread'), Type.Literal('post')]),
      targetId: UUID,
      securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.post.erased.v1': Type.Object(
    { postId: UUID, securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
  'com.rezics.content.moderation.erasure.v1': Type.Object(
    { threadId: UUID, postIds: Type.Array(UUID, { maxItems: 100 }), mediaIds: Type.Array(UUID, { maxItems: 100 }) },
    { additionalProperties: false },
  ),
} as const;

export type ModerationEventType = keyof typeof MODERATION_EVENTS;
export type ModerationEventData<T extends ModerationEventType> = Static<(typeof MODERATION_EVENTS)[T]>;
