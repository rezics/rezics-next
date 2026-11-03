import { t } from 'elysia';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { RatingQuestionResponseSchema, RatingVoteResponseSchema } from './schemas.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const path = t.String();
export const OwnVoteActionsSchema = t.Union([
  t.Object({ state: t.Literal('editable'), put: path, clear: path, readback: path }, closed),
  t.Object({ state: t.Literal('retired'), reason: t.Literal('question_retired'), clear: path, readback: path }, closed),
  t.Object(
    {
      state: t.Literal('unavailable'),
      reason: t.Union([t.Literal('merged_source'), t.Literal('identity_pending')]),
    },
    closed,
  ),
]);
export const OwnVotesPageSchema = t.Object(
  {
    viewer: t.Object({ accountId: id }, closed),
    votes: t.Array(
      t.Object(
        {
          targetId: id,
          questionId: id,
          subject: SubjectSummarySchema,
          subjectHref: path,
          question: RatingQuestionResponseSchema,
          own: RatingVoteResponseSchema,
          actions: OwnVoteActionsSchema,
        },
        closed,
      ),
      { maxItems: 20 },
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);
export const OwnVotesPageQuerySchema = t.Object(
  { cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })) },
  closed,
);
