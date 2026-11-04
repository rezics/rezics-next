import { t } from 'elysia';

export const MAX_VIEWER_FACTS_ROWS = 100;
export const MAX_VIEWER_FACTS_INPUT_BYTES = 16_384;
export const MAX_VIEWER_FACTS_RESPONSE_BYTES = 65_536;

const closed = { additionalProperties: false } as const;
const idSchema = t.String({ format: 'uuid' });
const nullableStringSchema = t.Union([t.String(), t.Null()]);
export const viewerFactSchema = t.Object(
  {
    rowKey: t.String(),
    subjectId: idSchema,
    entry: t.Union([
      t.Object(
        {
          state: t.Literal('present'),
          incarnationId: t.Union([idSchema, t.Null()]),
          entryState: nullableStringSchema,
          revision: t.Integer({ minimum: 0 }),
        },
        closed,
      ),
      t.Object({ state: t.Literal('absent') }, closed),
      t.Object({ state: t.Literal('unavailable'), reason: t.Literal('scope') }, closed),
    ]),
    vote: t.Union([
      t.Object(
        {
          state: t.Literal('present'),
          questionId: idSchema,
          questionRevision: t.Integer({ minimum: 1 }),
          units: t.Integer(),
          revision: t.Integer({ minimum: 1 }),
        },
        closed,
      ),
      t.Object(
        { state: t.Literal('absent'), questionId: idSchema, questionRevision: t.Integer({ minimum: 1 }) },
        closed,
      ),
      t.Object(
        { state: t.Literal('unavailable'), reason: t.Union([t.Literal('scope'), t.Literal('question')]) },
        closed,
      ),
    ]),
  },
  closed,
);

/** Wire type for admitted Library and Collection rows; unavailable authority remains explicit and value-free. */
export const viewerFactsResponseSchema = t.Union([
  t.Object(
    {
      state: t.Literal('current'),
      question: t.Union([
        t.Object(
          {
            id: idSchema,
            revision: t.Integer({ minimum: 1 }),
            grain: t.String(),
            scale: t.Object({ min: t.Integer(), max: t.Integer(), displayStep: t.Integer({ minimum: 1 }) }, closed),
            meaning: t.String(),
          },
          closed,
        ),
        t.Null(),
      ]),
      rows: t.Array(viewerFactSchema, { maxItems: MAX_VIEWER_FACTS_ROWS }),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Literal('unavailable'),
      reason: t.Union([t.Literal('identity'), t.Literal('currentness'), t.Literal('response_limit')]),
      retryable: t.Boolean(),
    },
    closed,
  ),
]);
