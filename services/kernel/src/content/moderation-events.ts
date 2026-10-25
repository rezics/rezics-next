import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

export const MODERATION_EVENTS = {
  'com.rezics.content.moderation.takedown.v1': Type.Object(
    {
      targetKind: Type.Union([Type.Literal('thread'), Type.Literal('post'), Type.Literal('media')]),
      targetId: UUID,
      securityRevision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.content.moderation.erasure.v1': Type.Object(
    { threadId: UUID, postIds: Type.Array(UUID), mediaIds: Type.Array(UUID) },
    { additionalProperties: false },
  ),
} as const;

export type ModerationEventType = keyof typeof MODERATION_EVENTS;
export type ModerationEventData<T extends ModerationEventType> = Static<(typeof MODERATION_EVENTS)[T]>;
