import { t } from 'elysia';
import type { Static } from 'typebox';
import { classifyUnavailability } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import { prepareFeedContentContext, type FeedContentContextDependencies } from './feed-context.ts';
import { FeedReviewTargetSchema } from './feed-context-schema.ts';
import type { ReadContext } from './model.ts';
import { readCitationDisclosure, type PostEntry, type ThreadView } from './reads.ts';

const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
/** The admitted opening and at most twenty selected replies, including sparse pages. */
export const READING_PAGE_CITATION_LIMIT = 21;

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

export const ReadingPageReviewContextSchema = t.Object(
  {
    source: t.Object(
      { threadId: uuid, postId: uuid, revisionId: t.Union([uuid, t.Null()]) },
      closed,
    ),
    target: t.Union([
      FeedReviewTargetSchema,
      t.Object({ state: t.Literal('unavailable') }, closed),
    ]),
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
);

export type ReadingPageReviewContext = Static<typeof ReadingPageReviewContextSchema>;

function optionalUnavailable(error: unknown): boolean {
  return (
    classifyUnavailability(error) !== undefined ||
    (error instanceof ProblemError && error.code === 'dependency_unavailable')
  );
}

/** The inventory is the admitted page, not a question lookup. Zero is a value;
 * concealed citations have no identity or numeric fields. Duplicate citations
 * on different native posts remain separate occurrences with their own revisions.
 */
export function readingPagePublishedCitations(
  thread: ThreadView,
  replies: readonly PostEntry[],
): ReadingPageReviewContext['citations'] {
  const posts = [thread.firstPost, ...replies];
  if (posts.length > READING_PAGE_CITATION_LIMIT) throw new RangeError('Reading page citation bound exceeded');
  if (new Set(posts.map((post) => post.id)).size !== posts.length)
    throw new TypeError('Duplicate reading page post key');
  for (const post of posts)
    if (post.threadId !== thread.id || post.route !== thread.route)
      throw new TypeError('Reading page citation source mismatch');
  return {
    state: 'current',
    items: posts.map((post) => {
      const disclosure = readCitationDisclosure(post);
      const recorded = 'voteCitation' in post ? post.voteCitation : null;
      const citation: Static<typeof PublishedCitationSchema> =
        post.availability !== 'available' || disclosure === 'withheld'
          ? { state: 'withheld' }
          : !recorded || disclosure === 'absent'
            ? { state: 'absent' }
            : {
                state: 'available',
                questionId: recorded.questionId,
                units: recorded.units,
                voteRevision: recorded.revision,
                metadata: { state: 'unavailable' },
              };
      return {
        postId: post.id,
        sourceRevisionId: 'revisionId' in post ? post.revisionId : null,
        citation,
      };
    }),
  };
}

/** Compose only the selected native thread. The existing Content preparer owns
 * Subject hydration and disclosure; native reading-page finalization observes
 * the source and selected reply interval again after this foreign work finishes.
 * A failed optional target never hides the thread or erases its citation inventory.
 */
export async function prepareReadingPageReviewContext(
  dependencies: FeedContentContextDependencies,
  thread: ThreadView,
  replies: readonly PostEntry[],
  context: ReadContext,
): Promise<Readonly<{ finish(): Promise<ReadingPageReviewContext | undefined> }>> {
  if (thread.kind !== 'review') return { finish: async () => undefined };
  const source = {
    threadId: thread.id,
    postId: thread.firstPost.id,
    revisionId: 'revisionId' in thread.firstPost ? thread.firstPost.revisionId : null,
  };
  const citations = readingPagePublishedCitations(thread, replies);
  let prepared: Awaited<ReturnType<typeof prepareFeedContentContext>> | undefined;
  try {
    prepared = await prepareFeedContentContext(
      dependencies,
      [{ key: thread.id, threadId: thread.id, initialThread: thread }],
      context,
      [],
      { questionMetadata: 'unavailable', confirmSubjects: true, authors: false },
    );
  } catch (error) {
    if (!optionalUnavailable(error)) throw error;
  }
  let finished = false;
  return {
    async finish() {
      if (finished) throw new TypeError('Reading page review context can finish only once');
      finished = true;
      let target: ReadingPageReviewContext['target'] = { state: 'unavailable' };
      if (prepared) {
        try {
          const current = await prepared.finish();
          target = current.contexts.get(thread.id)?.reviewContext?.target ?? target;
        } catch (error) {
          if (!optionalUnavailable(error)) throw error;
        }
      }
      return { source, target, citations };
    },
  };
}
