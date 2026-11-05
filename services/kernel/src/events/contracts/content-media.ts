import { Type, type Static } from 'typebox';

const UUID = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const mediaContainer = { mediaId: UUID, containerId: UUID };

export const MEDIA_EVENTS = {
  'com.rezics.content.media.reserved.v1': Type.Object(
    { ...mediaContainer, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.media.uploaded.v1': Type.Object(
    { ...mediaContainer, actorId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.media.available.v1': Type.Object(mediaContainer, { additionalProperties: false }),
  'com.rezics.content.media.rejected.v1': Type.Object(
    { ...mediaContainer, decisionId: UUID },
    { additionalProperties: false },
  ),
  'com.rezics.content.media.erased.v1': Type.Object(mediaContainer, { additionalProperties: false }),
  'com.rezics.content.media.collection-pending.v1': Type.Object(mediaContainer, { additionalProperties: false }),
  'com.rezics.content.media.collected.v1': Type.Object(mediaContainer, { additionalProperties: false }),
} as const;

export type MediaEventType = keyof typeof MEDIA_EVENTS;
export type MediaEventData<T extends MediaEventType> = Static<(typeof MEDIA_EVENTS)[T]>;
