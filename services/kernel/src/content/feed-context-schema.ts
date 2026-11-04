import { t } from 'elysia';
import type { FeedParentContext, FeedReviewContext } from './model.ts';

const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
const nullable = t.Union([t.String(), t.Null()]);

export const FeedReviewTargetSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      subject: t.Object(
        {
          id: uuid,
          kind: t.String({ minLength: 1, maxLength: 256 }),
          label: t.Union([
            t.Object({ value: t.String({ maxLength: 4096 }), language: t.String({ maxLength: 64 }) }, closed),
            t.Null(),
          ]),
        },
        closed,
      ),
    },
    closed,
  ),
  t.Object({ state: t.Union([t.Literal('absent'), t.Literal('withheld')]) }, closed),
]);

const reviewCitation = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      question: t.Object(
        {
          id: uuid,
          revision: t.Integer({ minimum: 1 }),
          label: t.String({ minLength: 1, maxLength: 4096 }),
          grain: t.Union([t.Literal('work'), t.Literal('release'), t.Literal('episode'), t.Literal('character')]),
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
      ),
      units: t.Integer(),
      voteRevision: t.Integer({ minimum: 1 }),
    },
    closed,
  ),
  t.Object({ state: t.Union([t.Literal('absent'), t.Literal('withheld')]) }, closed),
]);

export const FeedReviewContextSchema = t.Unsafe<FeedReviewContext>(
  t.Object({ target: FeedReviewTargetSchema, citation: reviewCitation }, closed),
);

const parentAuthor = t.Object({ id: uuid, displayName: nullable, handle: nullable }, closed);
const parent = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      id: uuid,
      revisionId: uuid,
      createdAt: t.String({ format: 'date-time' }),
      author: t.Union([parentAuthor, t.Null()]),
      excerpt: t.Union([t.String({ maxLength: 160 }), t.Null()]),
      language: t.Union([t.String({ maxLength: 256 }), t.Null()]),
      spoiler: t.Boolean(),
    },
    closed,
  ),
  t.Object({ state: t.Literal('removed'), id: uuid }, closed),
  t.Object({ state: t.Literal('withheld') }, closed),
]);

export const FeedParentContextSchema = t.Unsafe<FeedParentContext>(
  t.Union([t.Object({ kind: t.Literal('opening') }, closed), t.Object({ kind: t.Literal('reply'), parent }, closed)]),
);
