import { Type, type Static } from 'typebox';

/** Source tuple identity, revision and original removal provenance; governance evidence stays private. */
export const SOURCE_FENCE_EVENTS = {
  'com.rezics.content.source_fence.taken_down.v1': Type.Object(
    {
      route: Type.Integer({ minimum: 0, maximum: 65535 }),
      source: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$', maxLength: 32 }),
      external_id: Type.String({ minLength: 1, maxLength: 1024 }),
      field_group: Type.Union([Type.Literal('facts'), Type.Literal('summary'), Type.Literal('cover')]),
      securityRevision: Type.String({ pattern: '^[1-9][0-9]*$' }),
      takenDownAt: Type.Optional(Type.String()),
      takedownId: Type.Optional(
        Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
      ),
    },
    { additionalProperties: false },
  ),
} as const;

export type SourceFenceEventType = keyof typeof SOURCE_FENCE_EVENTS;
export type SourceFenceEventData<T extends SourceFenceEventType> = Static<(typeof SOURCE_FENCE_EVENTS)[T]>;
