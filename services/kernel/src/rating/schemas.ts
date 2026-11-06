import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { RatingQuestionLifecycleSchema, RatingQuestionResponseSchema } from './vote-response-schemas.ts';
export { RatingQuestionResponseSchema, RatingVoteResponseSchema } from './vote-response-schemas.ts';
import { SourceFiguresSchema } from './source-figures.ts';
import { SourceFenceQuerySchema, strictContentSchema } from '../content/schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const grain = t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]);

export {
  QuestionManagementQuerySchema,
  QuestionManagementResponseSchema,
  RatingQuestionLabelHistoryQuerySchema,
  RatingQuestionLabelHistorySchema,
  RatingQuestionLabelResultSchema,
  RatingQuestionLabelSchema,
} from './question-management-schemas.ts';

export function RatingVoteInputSchema() {
  return memoizedValue(RatingVoteInputSchema, () => strictContentSchema(t.Object({ units: t.Integer() }, closed)));
}

export function ClassificationBallotInputSchema() {
  return memoizedValue(ClassificationBallotInputSchema, () =>
    strictContentSchema(
      t.Object(
        { assessment: t.Union([t.Literal('support'), t.Literal('oppose')]), falsePositive: t.Boolean() },
        closed,
      ),
    ),
  );
}
export const ClassificationBallotMutationQuerySchema = t.Object(
  { expectedRevision: t.Optional(t.String({ minLength: 1, maxLength: 19, pattern: '^[1-9][0-9]*$' })) },
  closed,
);
export const ClassificationBallotSetResponseSchema = t.Object(
  {
    associationId: id,
    revision: t.String({ pattern: '^[1-9][0-9]*$' }),
    delivery: t.Union([t.Literal('enqueued'), t.Literal('unchanged')]),
  },
  closed,
);
export const ClassificationBallotOwnResponseSchema = t.Object(
  {
    associationId: id,
    hasBallot: t.Boolean(),
    assessment: t.Union([t.Literal('support'), t.Literal('oppose'), t.Null()]),
    falsePositive: t.Boolean(),
    revision: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
    pending: t.Boolean(),
  },
  closed,
);
const classificationAggregateAddress = { associationId: id, pending: t.Literal('unknown') };
export const ClassificationBallotAggregateResponseSchema = t.Union([
  t.Object({ ...classificationAggregateAddress, state: t.Literal('suppressed') }, closed),
  t.Object(
    {
      ...classificationAggregateAddress,
      state: t.Literal('published'),
      supportCount: t.Integer({ minimum: 0 }),
      opposeCount: t.Integer({ minimum: 0 }),
      falsePositiveCount: t.Integer({ minimum: 0 }),
      supportFraction: t.Union([t.Number({ minimum: 0, maximum: 1 }), t.Null()]),
      asOf: t.String({ format: 'date-time' }),
      generation: t.String({ pattern: '^[1-9][0-9]*$' }),
    },
    closed,
  ),
]);

export function RatingQuestionLifecycleInputSchema() {
  return memoizedValue(RatingQuestionLifecycleInputSchema, () =>
    strictContentSchema(
      t.Object({ expectedLifecycleRevision: t.Integer({ minimum: 1, maximum: 2_147_483_646 }) }, closed),
    ),
  );
}

export function RatingQuestionLifecycleResultSchema() {
  return memoizedValue(RatingQuestionLifecycleResultSchema, () =>
    t.Object({ questionId: id, lifecycle: RatingQuestionLifecycleSchema }, closed),
  );
}

export function RatingQuestionCreateInputSchema() {
  return memoizedValue(RatingQuestionCreateInputSchema, () =>
    strictContentSchema(
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
    ),
  );
}

export const RatingQuestionDirectoryQuerySchema = t.Object(
  {
    realm: t.Optional(id),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1, default: 20 })),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  closed,
);

export function RatingQuestionDirectoryResponseSchema() {
  return memoizedValue(RatingQuestionDirectoryResponseSchema, () =>
    t.Object(
      {
        ratingQuestions: t.Array(RatingQuestionResponseSchema, { maxItems: 20 }),
        next: t.Union([t.String(), t.Null()]),
      },
      closed,
    ),
  );
}

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

export function SourceStatisticInputSchema() {
  return memoizedValue(SourceStatisticInputSchema, () =>
    strictContentSchema(
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
    ),
  );
}

export function SourceStatisticClearInputSchema() {
  return memoizedValue(SourceStatisticClearInputSchema, () =>
    strictContentSchema(
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
    ),
  );
}

export function SourceStatisticResponseSchema() {
  return memoizedValue(SourceStatisticResponseSchema, () =>
    t.Object(
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
    ),
  );
}

export function SourceStatisticListResponseSchema() {
  return memoizedValue(SourceStatisticListResponseSchema, () =>
    t.Array(SourceStatisticResponseSchema(), { maxItems: 2 }),
  );
}

export function RatingQuestionLabelInputSchema() {
  return memoizedValue(RatingQuestionLabelInputSchema, () =>
    strictContentSchema(
      t.Object(
        {
          expectedLabelRevision: t.Integer({ minimum: 1, maximum: 2_147_483_646 }),
          label: t.String({ minLength: 1, maxLength: 200 }),
        },
        closed,
      ),
    ),
  );
}
