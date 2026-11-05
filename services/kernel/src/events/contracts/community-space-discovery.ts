import { Type, type Static } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const closed = { additionalProperties: false };
const key = (kind: 'space' | 'context' | 'media') => Type.Object({ kind: Type.Literal(kind), id }, closed);

/** An invalidation is not an eligible document or permission to disclose one. */
export const SpaceDiscoveryInvalidation = Type.Object(
  {
    target: Type.Union([
      key('space'),
      key('context'),
      key('media'),
      Type.Object(
        {
          kind: Type.Literal('source-fence'),
          route: Type.Integer({ minimum: 0, maximum: 65535 }),
          source: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
          externalId: Type.String({ minLength: 1, maxLength: 1024 }),
          fieldGroup: Type.Union([Type.Literal('facts'), Type.Literal('summary'), Type.Literal('cover')]),
        },
        closed,
      ),
      Type.Object({ kind: Type.Literal('exposure'), group: Type.String({ minLength: 1, maxLength: 63 }) }, closed),
    ]),
    origin: Type.Object(
      {
        partition: Type.Integer({ minimum: 0, maximum: 4095 }),
        epoch: Type.Integer({ minimum: 1 }),
        position: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
        eventId: id,
        resourceId: Type.Union([id, Type.Null()]),
        type: Type.String({ minLength: 1, maxLength: 256 }),
      },
      closed,
    ),
    revisionId: Type.Union([id, Type.Null()]),
    nativeVersion: Type.Union([Type.String({ pattern: '^(0|[1-9][0-9]*)$' }), Type.Null()]),
  },
  closed,
);
export type SpaceDiscoveryInvalidation = Static<typeof SpaceDiscoveryInvalidation>;
export const SPACE_DISCOVERY_INVALIDATED = 'com.rezics.community.space-discovery.invalidated.v1';
