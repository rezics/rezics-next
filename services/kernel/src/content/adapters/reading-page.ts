import {
  prepareReadingPageReviewContext,
  readReadingPageDocumentMedia,
  readReadingPageMentions,
  selectReadingPageActivity,
  readingPagePublishedCitations,
} from '../application/index.ts';
import type { ReadingPageOptional, ReadingPageMentionIdentity, ReadingPageCitationPost } from '../contract/index.ts';
import type { AnchoredPosition } from '../model.ts';
import type { ConversationActivitySelection } from '../conversation-activity.ts';
import { prepareFeedContentContext } from '../feed-context.ts';
import { readDocumentMediaPresentations } from '../media-presentation.ts';
import { readCitationDisclosure, type PostEntry } from '../reads.ts';
import type { ReadingPageCapabilities } from './reading-page-bind.ts';

/** Composition adapts Access's producer contract into these Content consumption operands. */
export type ContentReadingAccess = Readonly<{
  observe<T>(read: () => Promise<T>, deadline?: number): Promise<ReadingPageOptional<T>>;
  identities(
    pool: object,
    ids: readonly string[],
    deadline?: number,
  ): Promise<ReadingPageOptional<readonly ReadingPageMentionIdentity[]>>;
}>;

function citationPost(post: PostEntry): ReadingPageCitationPost {
  return {
    id: post.id,
    threadId: post.threadId,
    route: post.route,
    availability: post.availability,
    ...('revisionId' in post ? { revisionId: post.revisionId } : {}),
    voteCitation: 'voteCitation' in post ? post.voteCitation : null,
    disclosure: readCitationDisclosure(post),
  };
}

/** No native pool is captured. Every invocation carries its original dependency holder and budget. */
export function createNativeReadingPageCapabilities(access: ContentReadingAccess): ReadingPageCapabilities {
  return {
    publishedCitations(thread, replies) {
      return readingPagePublishedCitations(
        { id: thread.id, route: thread.route, kind: thread.kind, firstPost: citationPost(thread.firstPost) },
        replies.map(citationPost),
      );
    },
    selectActivity(producer, place, deadline) {
      return selectReadingPageActivity<AnchoredPosition, ConversationActivitySelection>(
        {
          select: (ids, budget) => access.observe(() => producer.select(ids, budget)),
          confirm: (selected, budget) => access.observe(() => producer.confirm(selected, budget)),
        },
        place,
        deadline,
      );
    },
    prepareReviewContext(dependencies, thread, replies, context) {
      return prepareReadingPageReviewContext(
        {
          prepare: () =>
            access.observe(async () => {
              const prepared = await prepareFeedContentContext(
                dependencies,
                [{ key: thread.id, threadId: thread.id, initialThread: thread }],
                context,
                [],
                { questionMetadata: 'unavailable', confirmSubjects: true, authors: false },
              );
              return {
                finish: () =>
                  access.observe(async () => {
                    const current = await prepared.finish();
                    return current.contexts.get(thread.id)?.reviewContext?.target ?? { state: 'unavailable' as const };
                  }),
              };
            }),
        },
        { id: thread.id, route: thread.route, kind: thread.kind, firstPost: citationPost(thread.firstPost) },
        replies.map(citationPost),
      );
    },
    readDocuments(dependencies, actor, selection, deadline) {
      return readReadingPageDocumentMedia(
        {
          read: (ids) =>
            access.observe(
              async () =>
                (
                  await readDocumentMediaPresentations(dependencies, actor, ids, {
                    deadline,
                    routeKey: dependencies.routeKey,
                  })
                ).images,
              deadline,
            ),
        },
        selection,
      );
    },
    readMentions(pool, selection, deadline) {
      return readReadingPageMentions({ read: (ids) => access.identities(pool, ids, deadline) }, selection);
    },
  };
}
