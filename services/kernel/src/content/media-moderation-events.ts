import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });

/** Identity and lossless security revision only; complaint evidence stays private. */
export const MEDIA_MODERATION_EVENTS = {
  'com.rezics.content.media.taken-down.v1': Type.Object(
    { mediaId: UUID, securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }) },
    { additionalProperties: false },
  ),
} as const;

export type MediaModerationEventType = keyof typeof MEDIA_MODERATION_EVENTS;
export type MediaModerationEventData<T extends MediaModerationEventType> = Static<(typeof MEDIA_MODERATION_EVENTS)[T]>;
