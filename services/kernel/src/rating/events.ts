import { Type } from 'typebox';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const units = Type.Union([Type.Integer({ minimum: 0, maximum: 20 }), Type.Null()]);

export const RATING_EVENTS = {
  'com.rezics.rating.voter-realm.changed.v1': Type.Object(
    { voterId: Type.String({ pattern: UUID }), realmId: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.vote.changed.v1': Type.Object(
    {
      voterId: Type.String({ pattern: UUID }),
      questionId: Type.String({ pattern: UUID }),
      targetId: Type.String({ pattern: UUID }),
      previous: units,
      units,
      revision: Type.Integer({ minimum: 1 }),
      populations: Type.Array(Type.String({ pattern: UUID }), { minItems: 1, maxItems: 101, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.rating.aggregate.applied.v1': Type.Object(
    { applied: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.source_statistic.changed.v1': Type.Object(
    {
      subjectId: Type.String({ pattern: UUID }),
      source: Type.Literal('vndb'),
      sourceRecordId: Type.String({ minLength: 1, maxLength: 1024 }),
    },
    { additionalProperties: false },
  ),
} as const;
