import { Type, type Static } from 'typebox';

/** Source evidence stays in the media partition; durable work carries only its ID. */
export const MEDIA_IMPORT_EVENTS = {
  'com.rezics.content.media.import-requested.v1': Type.Object(
    {
      mediaId: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
    },
    { additionalProperties: false },
  ),
} as const;

export type MediaImportEventType = keyof typeof MEDIA_IMPORT_EVENTS;
export type MediaImportEventData<T extends MediaImportEventType> = Static<(typeof MEDIA_IMPORT_EVENTS)[T]>;
