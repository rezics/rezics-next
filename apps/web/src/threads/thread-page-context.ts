import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { receiveThreadDocumentMedia, type ThreadDocumentMedia } from './document-media-read';
import {
  receiveThreadDocumentMentions,
  receiveThreadPostMentions,
  type ThreadDocumentMentions,
} from './thread-document-mentions';
import type { ThreadPost } from './thread-page';

export type { ThreadDocumentMentions } from './thread-document-mentions';

export type ThreadReviewContext = NonNullable<ReadingPageResponse['reviewContext']>;
export type ThreadPublishedCitation = ThreadReviewContext['citations']['items'][number]['citation'];

/** Preserve the native per-document binding. No image lookup or URL construction belongs in the page adapter. */
export function readingPageDocumentMedia(page: ReadingPageResponse): ThreadDocumentMedia {
  return receiveThreadDocumentMedia(page.documentMedia, [page.thread.firstPost, ...page.replies.items]);
}

/** The native identity batch is public, but each occurrence still belongs to its selected document revision. */
export function readingPageDocumentMentions(page: ReadingPageResponse): ThreadDocumentMentions {
  return page.mentions ?? { state: 'unavailable', sources: [], identities: [] };
}

export function mentionsForThreadPost(
  mentions: ThreadDocumentMentions,
  post: ThreadPost,
  pageIndex: number,
): DocumentMentions {
  return receiveThreadPostMentions(mentions, post, pageIndex);
}

/** Legacy prepared readers still accept the same receiver's complete page map. */
export function readingPageMentions(page: ReadingPageResponse): DocumentMentions {
  return receiveThreadDocumentMentions(page.mentions, [page.thread.firstPost, ...page.replies.items]);
}

/** A review target is independent of the selected page's Subject and remains bound to its admitted opening. */
export function readingPageReviewContext(page: ReadingPageResponse): ThreadReviewContext | undefined {
  const context = page.reviewContext;
  const opening = page.thread.firstPost;
  if (
    page.thread.kind !== 'review' ||
    !context ||
    context.source.threadId !== page.thread.id ||
    context.source.postId !== opening.id ||
    context.source.revisionId !== ('revisionId' in opening ? opening.revisionId : null)
  )
    return;
  return context;
}

/** Local revisions cannot inherit a previous head's citation, including an absent or concealed citation. */
export function publishedCitationForPost(
  context: ThreadReviewContext | undefined,
  post: ThreadPost,
): ThreadPublishedCitation | undefined {
  if (!context || post.threadId !== context.source.threadId) return;
  const selected = context.citations.items.find(
    (item) => item.postId === post.id && item.sourceRevisionId === ('revisionId' in post ? post.revisionId : null),
  );
  return selected?.citation;
}
