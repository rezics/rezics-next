import {
  READING_PAGE_CITATION_LIMIT,
  type ReadingPageReviewContext,
  type ReadingPageCitationThread,
  type ReadingPageCitationPost,
  type ReadingPagePublishedCitation,
  type ReadingPageReviewTargetPort,
} from '../contract/index.ts';

/** The inventory is the admitted page, not a question lookup. Zero is a value;
 * concealed citations have no identity or numeric fields. Duplicate citations
 * on different native posts remain separate occurrences with their own revisions.
 */
export function readingPagePublishedCitations(
  thread: ReadingPageCitationThread,
  replies: readonly ReadingPageCitationPost[],
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
      const disclosure = post.disclosure;
      const recorded = 'voteCitation' in post ? post.voteCitation : null;
      const citation: ReadingPagePublishedCitation =
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
        sourceRevisionId: post.revisionId ?? null,
        citation,
      };
    }),
  };
}

/** Preparation and finish retain the same source and citation values across foreign work. */
export async function prepareReadingPageReviewContext(
  port: ReadingPageReviewTargetPort,
  thread: ReadingPageCitationThread,
  replies: readonly ReadingPageCitationPost[],
): Promise<Readonly<{ finish(): Promise<ReadingPageReviewContext | undefined> }>> {
  if (thread.kind !== 'review') return { finish: async () => undefined };
  const source = { threadId: thread.id, postId: thread.firstPost.id, revisionId: thread.firstPost.revisionId ?? null };
  const citations = readingPagePublishedCitations(thread, replies);
  const prepared = await port.prepare();
  let finished = false;
  return {
    async finish() {
      if (finished) throw new TypeError('Reading page review context can finish only once');
      finished = true;
      let target: ReadingPageReviewContext['target'] = { state: 'unavailable' };
      if (prepared.state === 'current') {
        const current = await prepared.value.finish();
        if (current.state === 'current') target = current.value;
      }
      return { source, target, citations };
    },
  };
}
