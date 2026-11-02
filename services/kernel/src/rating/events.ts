import { Type, type Static } from 'typebox';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const units = Type.Union([Type.Integer({ minimum: 0, maximum: 20 }), Type.Null()]);

export const POPULATION_TOTAL_DELIVERY = 'com.rezics.rating.population-total.delivery.v1';
const serial = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const signed = Type.String({ pattern: '^-?(0|[1-9][0-9]{0,18})$' });
const deliveryAddress = {
  sourcePartition: Type.Integer({ minimum: 0, maximum: 4095 }),
  populationId: Type.String({ pattern: UUID }),
  serial,
};
const populationTotalDelivery = Type.Union([
  Type.Object(
    {
      ...deliveryAddress,
      action: Type.Literal('deliver'),
      deltas: Type.Array(
        Type.Object(
          {
            questionId: Type.String({ pattern: UUID }),
            shard: Type.Integer({ minimum: 0, maximum: 15 }),
            count: signed,
            sum: signed,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 200 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ ...deliveryAddress, action: Type.Literal('received') }, { additionalProperties: false }),
]);
export type PopulationTotalEvent = Static<typeof populationTotalDelivery>;
export type PopulationTotalDelivery = Extract<PopulationTotalEvent, { action: 'deliver' }>;

export const RATING_IDENTITY_PAGE = 'com.rezics.rating.identity-repair.page.v1';
const identityPage = Type.Object({
  voterId: Type.String({ pattern: UUID }), workId: Type.String({ pattern: UUID }),
  generation: serial, pageId: Type.String({ pattern: UUID }),
  digest: Type.String({ pattern: '^[0-9a-f]{64}$' }), terminal: Type.Boolean(),
  mode: Type.Union([Type.Literal('repair'), Type.Literal('withdrawal')]),
}, { additionalProperties: false });
export type RatingIdentityPageEvent = Static<typeof identityPage>;

export const RATING_EVENTS = {
  [RATING_IDENTITY_PAGE]: identityPage,
  [POPULATION_TOTAL_DELIVERY]: populationTotalDelivery,
  'com.rezics.rating.erasure-page.applied.v1': Type.Object(
    { voterId: Type.String({ pattern: UUID }), pageId: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.voter-realm.changed.v1': Type.Object(
    { voterId: Type.String({ pattern: UUID }), realmId: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
  'com.rezics.rating.vote.changed.v1': Type.Object(
    {
      voterId: Type.String({ pattern: UUID }),
      questionId: Type.String({ pattern: UUID }),
      targetId: Type.String({ pattern: UUID }),
      aggregateTargetId: Type.Optional(Type.String({ pattern: UUID })),
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
  'com.rezics.rating.prior_epoch.work.v1': Type.Object(
    {
      action: Type.Union([Type.Literal('check'), Type.Literal('mark'), Type.Literal('advance')]),
      questionId: Type.String({ pattern: UUID }),
      populationId: Type.String({ pattern: UUID }),
      generation: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
      subjects: Type.Integer({ minimum: 0, maximum: 500 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.rating.public_figure.changed.v1': Type.Object(
    {
      questionId: Type.String({ pattern: UUID }),
      populationId: Type.String({ pattern: UUID }),
      subjectId: Type.String({ pattern: UUID }),
      count: Type.Integer({ minimum: 0 }),
      mean: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
      score: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
      m: Type.Union([Type.Number({ minimum: 0, maximum: 10 }), Type.Null()]),
      C: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      priorEpoch: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      revision: Type.String({ pattern: '^[1-9][0-9]*$' }),
      asOf: Type.Union([Type.String(), Type.Null()]),
      position: Type.String({ pattern: '^[1-9][0-9]*$' }),
    },
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
              countedTargetId: Type.Optional(Type.Union([Type.String({ pattern: UUID }), Type.Null()])),
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
        erasurePageId: Type.Optional(Type.String({ pattern: UUID })),
        votes: Type.Array(
          Type.Object(
            {
              questionId: Type.String({ pattern: UUID }),
              targetId: Type.String({ pattern: UUID }),
              countedTargetId: Type.Optional(Type.Union([Type.String({ pattern: UUID }), Type.Null()])),
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
              countedTargetId: Type.Optional(Type.Union([Type.String({ pattern: UUID }), Type.Null()])),
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
  'com.rezics.rating.subject-merge.page.v1': Type.Object(
    {
      id: Type.String({ pattern: UUID }),
      survivor: Type.String({ pattern: UUID }),
      voters: Type.Integer({ minimum: 0, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
} as const;
