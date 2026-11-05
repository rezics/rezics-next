import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { REVIEW_CONTEXT_LIMITS, type SearchReviewContext } from './review-context.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
export const ReviewContextSourceSchema = t.Object(
  {
    openingRevisionId: id,
    sourceVersion: t.String({ minLength: 1, maxLength: 128 }),
  },
  closed,
);
const citation = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      recorded: t.Object({ questionId: id, units: t.Integer(), revision: t.Integer({ minimum: 1 }) }, closed),
      historicalQuestion: t.Object({ state: t.Literal('unavailable') }, closed),
    },
    closed,
  ),
  t.Object(
    {
      state: t.Union(
        ['absent', 'unsupported', 'unavailable', 'withdrawn', 'erased', 'withheld'].map((state) => t.Literal(state)),
      ),
    },
    closed,
  ),
]);
export function SearchReviewContextSchema() {
  return memoizedValue(SearchReviewContextSchema, () =>
    t.Unsafe<SearchReviewContext>(
      t.Union([
        t.Object({ state: t.Literal('unavailable') }, closed),
        t.Object(
          {
            state: t.Literal('available'),
            openingPostId: id,
            target: t.Union([
              t.Object(
                {
                  state: t.Literal('available'),
                  subject: t.Object(
                    {
                      ...SubjectSummarySchema.properties,
                      type: t.String({ maxLength: 256 }),
                      types: t.Array(t.String({ maxLength: 256 }), { maxItems: 16 }),
                      label: t.Union([
                        t.Object(
                          { value: t.String({ maxLength: 1024 }), language: t.String({ maxLength: 64 }) },
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
              t.Object({ state: t.Union([t.Literal('withheld'), t.Literal('unavailable')]) }, closed),
            ]),
            citation,
            language: t.Union([t.String({ maxLength: 64 }), t.Null()]),
            spoiler: t.Boolean(),
          },
          closed,
        ),
      ]),
    ),
  );
}

export function searchContextBytes(value: SearchReviewContext): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Withheld context cannot carry any fallback identity through a sibling slot. */
export function validReviewContextBinding(value: {
  source?: { openingRevisionId: string; sourceVersion: string };
  searchContext?: SearchReviewContext;
  subject?: { id: string; title?: string | null } | null;
}): boolean {
  const context = value.searchContext;
  if (!context) return true;
  if (!value.source || searchContextBytes(context) > REVIEW_CONTEXT_LIMITS.rowBytes) return false;
  if (context.state !== 'available') return !value.subject;
  if (context.target.state !== 'available') return !value.subject && context.citation.state !== 'available';
  return !value.subject || value.subject.id === context.target.subject.id;
}
