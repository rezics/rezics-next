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
      populations: Type.Array(Type.String({ pattern: UUID }), { maxItems: 101, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.rating.aggregate.applied.v1': Type.Object(
    { applied: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.segment.page.v1': Type.Union([
    Type.Object(
      {
        voterId: Type.String({ pattern: UUID }),
        direction: Type.Literal('rekey'),
        at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?[+-]\\d{2}$' }),
        allowMissing: Type.Boolean(),
        votes: Type.Array(
          Type.Object(
            {
              questionId: Type.String({ pattern: UUID }),
              targetId: Type.String({ pattern: UUID }),
              units,
              revision: Type.Integer({ minimum: 1 }),
              populations: Type.Array(Type.String({ pattern: UUID }), { maxItems: 101, uniqueItems: true }),
              changedAt: Type.String(),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        voterId: Type.String({ pattern: UUID }),
        direction: Type.Union([Type.Literal('adding'), Type.Literal('removing')]),
        votes: Type.Array(
          Type.Object(
            {
              questionId: Type.String({ pattern: UUID }),
              targetId: Type.String({ pattern: UUID }),
              units,
              revision: Type.Integer({ minimum: 1 }),
              populations: Type.Array(Type.String({ pattern: UUID }), { maxItems: 101, uniqueItems: true }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        voterId: Type.String({ pattern: UUID }),
        realmId: Type.String({ pattern: UUID }),
        direction: Type.Union([Type.Literal('adding'), Type.Literal('removing')]),
        votes: Type.Array(
          Type.Object(
            {
              questionId: Type.String({ pattern: UUID }),
              targetId: Type.String({ pattern: UUID }),
              units,
              revision: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
  ]),
  'com.rezics.rating.eligibility.changed.v1': Type.Object(
    { voterId: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.population.pending.v1': Type.Object(
    { populationId: Type.String({ pattern: UUID }), pendingJobs: Type.Integer({ minimum: 0 }) },
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
