import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { FeedReviewTargetSchema } from './feed-context-schema.ts';
import type { FeedContentContextDependencies } from './feed-context.ts';
import type { ReadContext } from './model.ts';
import type { PostEntry, ThreadView } from './reads.ts';
import { READING_PAGE_CITATION_LIMIT } from './contract/index.ts';
import { readingPageCapabilities } from './adapters/reading-page-bind.ts';

const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
/** The admitted opening and at most twenty selected replies, including sparse pages. */
export { READING_PAGE_CITATION_LIMIT } from './contract/index.ts';

const PublishedCitationSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      questionId: uuid,
      units: t.Integer(),
      voteRevision: t.Integer({ minimum: 1 }),
      // No exact historical question reader is installed. A current question's
      // label, scale or revision cannot describe the recorded vote's units.
      metadata: t.Object({ state: t.Literal('unavailable') }, closed),
    },
    closed,
  ),
  t.Object({ state: t.Union([t.Literal('absent'), t.Literal('withheld')]) }, closed),
]);

export function ReadingPageReviewContextSchema() {
  return memoizedValue(ReadingPageReviewContextSchema, () =>
    t.Object(
      {
        source: t.Object({ threadId: uuid, postId: uuid, revisionId: t.Union([uuid, t.Null()]) }, closed),
        target: t.Union([FeedReviewTargetSchema, t.Object({ state: t.Literal('unavailable') }, closed)]),
        citations: t.Object(
          {
            state: t.Literal('current'),
            items: t.Array(
              t.Object(
                {
                  postId: uuid,
                  sourceRevisionId: t.Union([uuid, t.Null()]),
                  citation: PublishedCitationSchema,
                },
                closed,
              ),
              { minItems: 1, maxItems: READING_PAGE_CITATION_LIMIT },
            ),
          },
          closed,
        ),
      },
      closed,
    ),
  );
}

export type { ReadingPageReviewContext } from './contract/index.ts';

export function readingPagePublishedCitations(thread: ThreadView, replies: readonly PostEntry[]) {
  return readingPageCapabilities().publishedCitations(thread, replies);
}
export function prepareReadingPageReviewContext(
  dependencies: FeedContentContextDependencies,
  thread: ThreadView,
  replies: readonly PostEntry[],
  context: ReadContext,
) {
  return readingPageCapabilities().prepareReviewContext(dependencies, thread, replies, context);
}
