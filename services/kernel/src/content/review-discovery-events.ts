import { Type, type Static } from 'typebox';

const uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
export const REVIEW_DISCOVERY_OPENED = 'com.rezics.content.review-discovery.opened.v1';
export const REVIEW_DISCOVERY_PROGRESS = 'com.rezics.content.review-discovery.progress.v1';
export const REVIEW_DISCOVERY_CHANGED = 'com.rezics.content.review-discovery.changed.v1';
const reference = {
  route: Type.Integer({ minimum: 0, maximum: 65535 }),
  id: uuid,
};
const origin = Type.Object(
  {
    partition: Type.Integer({ minimum: 0, maximum: 4095 }),
    epoch: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    position,
    eventIndex: Type.Integer({ minimum: 0, maximum: 999 }),
    id: uuid,
    type: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export type ReviewDiscoveryOrigin = Static<typeof origin>;
export type ReviewDiscoveryWork = Readonly<Static<typeof work>>;
const work = Type.Object(reference, { additionalProperties: false });
export const REVIEW_DISCOVERY_EVENTS = {
  [REVIEW_DISCOVERY_OPENED]: work,
  [REVIEW_DISCOVERY_PROGRESS]: Type.Object(
    { ...reference, version: position, complete: Type.Boolean() },
    { additionalProperties: false },
  ),
  [REVIEW_DISCOVERY_CHANGED]: Type.Object(
    {
      partition: Type.Integer({ minimum: 0, maximum: 4095 }),
      through: position,
      ids: Type.Array(uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
      origin,
    },
    { additionalProperties: false },
  ),
} as const;
