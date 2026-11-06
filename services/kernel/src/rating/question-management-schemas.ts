import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { RatingQuestionLifecycleSchema, RatingQuestionResponseSchema } from './vote-response-schemas.ts';

// Realm question-management and caption-history shapes. They stay outside rating/schemas.ts, whose Content imports load
// a SQL-backed graph, so the Web seam for these closed responses loads only this module.

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_647 });
const grain = t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]);

export const QuestionManagementQuerySchema = t.Object(
  {
    selectedQuestionId: t.Optional(id),
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
  },
  closed,
);

const managementHref = t.String({ minLength: 1, maxLength: 128 });
function managementQuestion() {
  return memoizedValue(managementQuestion, () =>
    t.Object(
      {
        ...RatingQuestionResponseSchema.properties,
        grain,
        realmId: id,
        meaning: t.String({ minLength: 1, maxLength: 2000 }),
        canonicalLabel: t.String({ minLength: 1, maxLength: 200 }),
        labelRevision: revision,
        lifecycle: RatingQuestionLifecycleSchema,
      },
      closed,
    ),
  );
}

export function QuestionManagementResponseSchema() {
  return memoizedValue(QuestionManagementResponseSchema, () =>
    t.Object(
      {
        viewer: t.Object({ accountId: id }, closed),
        realmId: id,
        directory: t.Object(
          {
            ratingQuestions: t.Array(managementQuestion(), { maxItems: 20 }),
            next: t.Union([t.String({ minLength: 1, maxLength: 4096 }), t.Null()]),
          },
          closed,
        ),
        actions: t.Object(
          {
            create: t.Union([t.Object({ method: t.Literal('POST'), href: managementHref }, closed), t.Null()]),
          },
          closed,
        ),
        selected: t.Union([
          t.Object(
            {
              question: managementQuestion(),
              readback: managementHref,
              history: managementHref,
              actions: t.Object(
                {
                  caption: t.Union([
                    t.Object(
                      { method: t.Literal('PUT'), href: managementHref, expectedLabelRevision: revision },
                      closed,
                    ),
                    t.Null(),
                  ]),
                  lifecycle: t.Union([
                    t.Object(
                      { method: t.Literal('POST'), href: managementHref, expectedLifecycleRevision: revision },
                      closed,
                    ),
                    t.Null(),
                  ]),
                },
                closed,
              ),
            },
            closed,
          ),
          t.Null(),
        ]),
      },
      closed,
    ),
  );
}

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
