import { t } from 'elysia';
import { SourceFiguresSchema } from './source-figures.ts';
import { SourceFenceQuerySchema, strictContentSchema } from '../content/schemas.ts';

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

const RatingQuestionLifecycleSchema = t.Object(
  { state: t.Union([t.Literal('active'), t.Literal('retired')]), revision },
  closed,
);

export const RatingQuestionResponseSchema = t.Object(
  {
    id,
    revision,
    realmId: t.Optional(id),
    canonicalLabel: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
    labelRevision: t.Optional(revision),
    meaning: t.Optional(t.String({ minLength: 1, maxLength: 2000 })),
    label: t.String({ minLength: 1, maxLength: 200 }),
    grain,
    lifecycle: t.Optional(RatingQuestionLifecycleSchema),
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

export const RatingQuestionLifecycleInputSchema = strictContentSchema(
  t.Object({ expectedLifecycleRevision: t.Integer({ minimum: 1, maximum: 2_147_483_646 }) }, closed),
);

export const RatingQuestionLifecycleResultSchema = t.Object(
  { questionId: id, lifecycle: RatingQuestionLifecycleSchema },
  closed,
);

export const RatingQuestionCreateInputSchema = strictContentSchema(
  t.Object(
    {
      meaning: t.String({ minLength: 1, maxLength: 2000 }),
      label: t.String({ minLength: 1, maxLength: 200 }),
      grain,
      scale: t.Object(
        {
          min: t.Integer({ minimum: 0, maximum: 19 }),
          max: t.Integer({ minimum: 1, maximum: 20 }),
          displayStep: t.Integer({ minimum: 1, maximum: 20 }),
        },
        closed,
      ),
    },
    closed,
  ),
);

export const RatingQuestionDirectoryQuerySchema = t.Object(
  {
    realm: t.Optional(id),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1, default: 20 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  closed,
);

export const RatingQuestionDirectoryResponseSchema = t.Object(
  {
    ratingQuestions: t.Array(RatingQuestionResponseSchema, { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
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
      expectedObservation: t.Optional(t.Union([t.String({ pattern: '^[0-9a-f]{64}$' }), t.Null()])),
      sourceAlias: t.Optional(SourceFenceQuerySchema.properties.source),
      sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
      figures: t.Optional(SourceFiguresSchema),
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
      expectedObservation: t.Optional(t.Union([t.String({ pattern: '^[0-9a-f]{64}$' }), t.Null()])),
      sourceAlias: t.Optional(SourceFenceQuerySchema.properties.source),
      sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
      count: t.Literal(0),
      asOf: t.String({ format: 'date' }),
    },
    closed,
  ),
);

export const SourceStatisticResponseSchema = t.Object(
  {
    source: t.Union([t.Literal('vndb'), t.Literal('bangumi')]),
    observation: t.Optional(
      t.Object({ kind: t.Literal('unversioned'), digest: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed),
    ),
    sourceAlias: t.Optional(SourceFenceQuerySchema.properties.source),
    sourceRecordId: t.String({ minLength: 1, maxLength: 1024 }),
    figures: t.Optional(SourceFiguresSchema),
    scale: sourceScale,
    mean: t.Number(),
    count: t.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    asOf: t.String({ format: 'date' }),
    licence: t.String({ minLength: 1, maxLength: 1024 }),
    attribution: t.String({ minLength: 1, maxLength: 2000 }),
  },
  closed,
);

export const SourceStatisticListResponseSchema = t.Array(SourceStatisticResponseSchema, { maxItems: 2 });

export const RatingQuestionLabelInputSchema = strictContentSchema(
  t.Object(
    {
      expectedLabelRevision: t.Integer({ minimum: 1, maximum: 2_147_483_646 }),
      label: t.String({ minLength: 1, maxLength: 200 }),
    },
    closed,
  ),
);

export const RatingQuestionLabelResultSchema = t.Object(
  {
    questionId: id,
    labelRevision: revision,
    label: t.String({ minLength: 1, maxLength: 200 }),
  },
  closed,
);

const labelAuthor = t.Union([
  t.Object({ id, kind: t.Union([t.Literal('actor'), t.Literal('organization')]), state: t.Literal('deleted') }, closed),
  t.Object(
    {
      id,
      kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
      state: t.Literal('active'),
      handle: t.Union([t.String(), t.Null()]),
      displayName: t.Union([t.String(), t.Null()]),
      automated: t.Boolean(),
      operatorId: t.Union([id, t.Null()]),
    },
    closed,
  ),
  t.Null(),
]);

export const RatingQuestionLabelSchema = t.Object(
  {
    ...RatingQuestionLabelResultSchema.properties,
    at: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    author: labelAuthor,
  },
  closed,
);

export const RatingQuestionLabelHistoryQuerySchema = t.Object(
  {
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1, default: 20 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  closed,
);

export const RatingQuestionLabelHistorySchema = t.Object(
  {
    labels: t.Array(RatingQuestionLabelSchema, { maxItems: 20 }),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);
