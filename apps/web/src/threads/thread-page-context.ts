import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import type { ThreadDocumentMedia } from './document-media-read';
import type { ThreadPost } from './thread-page';

type NativeMentions = NonNullable<ReadingPageResponse['mentions']>;
export type ThreadDocumentMentions = Pick<NativeMentions, 'state' | 'sources' | 'identities'>;
export type ThreadReviewContext = NonNullable<ReadingPageResponse['reviewContext']>;
export type ThreadPublishedCitation = ThreadReviewContext['citations']['items'][number]['citation'];

/** Preserve the native per-document binding. No image lookup or URL construction belongs in the page adapter. */
export function readingPageDocumentMedia(page: ReadingPageResponse): ThreadDocumentMedia {
  const media = page.documentMedia;
  if (media.state !== 'available')
    return { kind: 'unavailable', ...(media.state === 'overflow' ? { reason: 'overflow' as const } : {}) };
  const images = new Map<string, Extract<ThreadDocumentMedia, { kind: 'ready' }>['images'][number]>();
  const documents: Extract<ThreadDocumentMedia, { kind: 'ready' }>['documents'][number][] = [];
  const posts = [page.thread.firstPost, ...page.replies.items];
  for (const document of media.documents) {
    if (document.state !== 'available') continue;
    const pageIndex = posts.findIndex((post) => post.id === document.postId);
    const post = pageIndex >= 0 ? posts[pageIndex] : undefined;
    if (
      post?.availability !== 'available' ||
      post.threadId !== document.threadId ||
      post.revisionId !== document.revisionId ||
      post.sha256 !== document.sha256
    )
      continue;
    const mediaIds: string[] = [];
    for (const image of document.images) {
      if (
        image.state !== 'available' ||
        image.id !== image.presentation.id ||
        image.presentation.containerId !== document.threadId ||
        !post.mediaIds.includes(image.id)
      )
        continue;
      mediaIds.push(image.id);
      images.set(image.id, image.presentation);
    }
    documents.push({
      pageIndex,
      postId: document.postId,
      threadId: document.threadId,
      revisionId: document.revisionId,
      sha256: document.sha256,
      mediaIds,
    });
  }
  return { kind: 'ready', documents, images: [...images.values()] };
}

/** The native identity batch is public, but each occurrence still belongs to its selected document revision. */
export function readingPageDocumentMentions(page: ReadingPageResponse): ThreadDocumentMentions {
  return page.mentions ?? { state: 'unavailable', sources: [], identities: [] };
}

export function mentionsForThreadPost(mentions: ThreadDocumentMentions, post: ThreadPost): DocumentMentions {
  if (mentions.state !== 'current' || post.availability !== 'available') return {};
  const source = mentions.sources.find(
    (source) =>
      source.postId === post.id &&
      source.threadId === post.threadId &&
      source.revisionId === post.revisionId &&
      source.sha256 === post.sha256,
  );
  if (!source) return {};
  const admitted = new Set(source.references);
  return Object.fromEntries(
    mentions.identities.flatMap((identity) =>
      admitted.has(identity.id) && identity.state === 'active' && identity.handle
        ? [[identity.id, { handle: identity.handle }]]
        : [],
    ),
  );
}

/** Legacy prepared readers still accept a page map; production posts use the exact-document map above. */
export function readingPageMentions(page: ReadingPageResponse): DocumentMentions {
  const mentions = readingPageDocumentMentions(page);
  return Object.assign(
    {},
    ...[page.thread.firstPost, ...page.replies.items].map((post) => mentionsForThreadPost(mentions, post)),
  );
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
