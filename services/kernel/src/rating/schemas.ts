import { t } from 'elysia';
import { strictContentSchema } from '../content/schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const grain = t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]);

export const RatingVoteInputSchema = strictContentSchema(t.Object({ units: t.Integer() }, closed));

export const RatingVoteResponseSchema = t.Object(
  {
    units: t.Integer(),
    revision,
    at: t.String({ format: 'date-time' }),
  },
  closed,
);

export const RatingQuestionResponseSchema = t.Object(
  {
    id,
    revision,
    label: t.String({ minLength: 1, maxLength: 200 }),
    grain,
    scale: t.Object(
      {
        min: t.Integer(),
        max: t.Integer(),
        displayStep: t.Integer({ minimum: 1 }),
      },
      closed,
    ),
  },
  closed,
);

const RatingFreshnessSchema = t.Object(
  {
    asOf: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    updating: t.Boolean(),
  },
  closed,
);

const ratingFigureFields = {
  population: id,
  count: t.Integer({ minimum: 0 }),
  freshness: RatingFreshnessSchema,
};

export const RatingAggregateFigureSchema = t.Union([
  t.Object(
    { ...ratingFigureFields, mean: t.Number(), histogram: t.Array(t.Integer({ minimum: 0 }), { minItems: 1 }) },
    closed,
  ),
  t.Object({ ...ratingFigureFields, remaining: t.Integer({ minimum: 1 }) }, closed),
  t.Object(ratingFigureFields, closed),
]);

export const RatingAggregateResponseSchema = t.Object(
  {
    question: id,
    subject: id,
    figures: t.Array(RatingAggregateFigureSchema, { minItems: 1, maxItems: 20 }),
  },
  closed,
);

export const RatingPopulationPageResponseSchema = t.Object(
  {
    populations: t.Array(t.Object({ population: id, count: t.Integer({ minimum: 1 }) }, closed), { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);

const sourceScale = t.Object(
  {
    min: t.Integer({ minimum: 0, maximum: 4096 }),
    max: t.Integer({ minimum: 1, maximum: 4096 }),
  },
  closed,
);

export const SourceStatisticInputSchema = strictContentSchema(
  t.Object(
    {
      sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
      scale: sourceScale,
      mean: t.Number(),
      count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
      asOf: t.String({ format: 'date' }),
      licence: t.String({ minLength: 1, maxLength: 1024 }),
      attribution: t.String({ minLength: 1, maxLength: 2000 }),
    },
    closed,
  ),
);

export const SourceStatisticClearInputSchema = strictContentSchema(
  t.Object(
    {
      sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
      count: t.Literal(0),
      asOf: t.String({ format: 'date' }),
    },
    closed,
  ),
);

export const SourceStatisticResponseSchema = t.Object(
  {
    source: t.Literal('vndb'),
    sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
    scale: sourceScale,
    mean: t.Number(),
    count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    asOf: t.String({ format: 'date' }),
    licence: t.String({ minLength: 1, maxLength: 1024 }),
    attribution: t.String({ minLength: 1, maxLength: 2000 }),
  },
  closed,
);

export const SourceStatisticListResponseSchema = t.Array(SourceStatisticResponseSchema);
