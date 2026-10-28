import { Type } from 'typebox';
const change = Type.Object(
  {
    id: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }),
    revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
  },
  { additionalProperties: false },
);
/** Resource events intentionally contain no private payload or ownership/source references. */
export const ZONE_EVENTS = {
  'com.rezics.zone.created.v1': change,
  'com.rezics.zone.configured.v1': change,
  'com.rezics.zone.published.v1': change,
  'com.rezics.zone.deleted.v1': change,
  'com.rezics.zone.restored.v1': change,
} as const;
