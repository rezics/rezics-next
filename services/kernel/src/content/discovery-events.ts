import { Type, type Static } from 'typebox';

const id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const version = Type.String({ pattern: '^[1-9][0-9]*$' });
export const DISCOVERY_DELTA = 'com.rezics.content.realm-discovery.changed.v1';
export const DISCOVERY_EVENTS = {
  [DISCOVERY_DELTA]: Type.Object(
    {
      realmId: id,
      realmEpoch: version,
      spaceId: id,
      boardId: id,
      threadId: id,
      sourceRoute: Type.Integer({ minimum: 0, maximum: 65535 }),
      creationDay: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      sourceVersion: version,
      contributing: Type.Boolean(),
      change: Type.Union([Type.Literal(1), Type.Literal(-1)]),
    },
    { additionalProperties: false },
  ),
} as const;
export type DiscoveryDelta = Static<(typeof DISCOVERY_EVENTS)[typeof DISCOVERY_DELTA]>;

export const DISCOVERY_PREPARED = 'com.rezics.content.realm-discovery.prepared.v1';
export const DISCOVERY_OUTCOME = 'com.rezics.content.realm-discovery.outcome.v1';
const operation = Type.Object(
  {
    route: Type.Integer({ minimum: 0, maximum: 65535 }),
    intent: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    generation: version,
  },
  { additionalProperties: false },
);
export const DISCOVERY_OPERATION_EVENTS = {
  [DISCOVERY_PREPARED]: operation,
  [DISCOVERY_OUTCOME]: operation,
} as const;
