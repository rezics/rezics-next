import type { ReadingPageResponse } from '@rezics/client';
import type { DocumentImagePresentation } from './document-media';
import type { ThreadPost } from './thread-page';

type DocumentBinding = Readonly<{
  pageIndex: number;
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  mediaIds: readonly string[];
}>;

/** Serializable page data. A summary belongs only to the exact delivered current document that named it. */
export type ThreadDocumentMedia =
  | { kind: 'ready'; images: readonly DocumentImagePresentation[]; documents: readonly DocumentBinding[] }
  | { kind: 'unavailable'; reason?: 'overflow' };

type ReadingPageMedia = ReadingPageResponse['documentMedia'];

/** Adapt the already-admitted ReadingPage projection for the existing post renderer. */
export function receiveThreadDocumentMedia(
  projection: ReadingPageMedia,
  posts: readonly ThreadPost[],
): ThreadDocumentMedia {
  if (projection.state !== 'available')
    return { kind: 'unavailable', ...(projection.state === 'overflow' ? { reason: 'overflow' as const } : {}) };

  const images = new Map<string, DocumentImagePresentation>();
  const documents: DocumentBinding[] = [];
  const seenPosts = new Set<string>();
  for (const source of projection.documents) {
    const pageIndex = posts.findIndex(
      (candidate) =>
        candidate.availability === 'available' &&
        candidate.id === source.postId &&
        candidate.threadId === source.threadId &&
        candidate.revisionId === source.revisionId &&
        candidate.sha256 === source.sha256,
    );
    if (pageIndex < 0) continue;
    const post = posts[pageIndex]!;
    if (seenPosts.has(post.id)) return { kind: 'unavailable' };
    seenPosts.add(post.id);
    const declared = new Set(post.mediaIds);
    const selected: string[] = [];
    const selectedSet = new Set<string>();
    if (source.state !== 'available') return { kind: 'unavailable' };
    for (const item of source.images) {
      if (item.state !== 'available') return { kind: 'unavailable' };
      const image = item.presentation;
      if (
        !declared.has(item.id) ||
        image.id !== item.id ||
        image.containerId !== post.threadId ||
        selectedSet.has(item.id)
      )
        return { kind: 'unavailable' };
      const previous = images.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(image)) return { kind: 'unavailable' };
      if (!previous) images.set(item.id, image);
      selected.push(item.id);
      selectedSet.add(item.id);
    }
    if (selected.length)
      documents.push({
        pageIndex,
        postId: post.id,
        threadId: post.threadId,
        revisionId: post.revisionId,
        sha256: post.sha256,
        mediaIds: selected,
      });
  }
  return { kind: 'ready', images: [...images.values()], documents };
}

/** Index only exact current-document disclosures. Building the index never reads or guesses attachment URLs. */
export function documentImagesForPost(
  media: ThreadDocumentMedia | undefined,
  post: ThreadPost,
  pageIndex = 0,
): ReadonlyMap<string, DocumentImagePresentation> {
  const images = new Map<string, DocumentImagePresentation>();
  if (media?.kind !== 'ready' || post.availability !== 'available') return images;
  const bound = new Set<string>();
  for (const document of media.documents) {
    if (
      document.pageIndex === pageIndex &&
      document.postId === post.id &&
      document.threadId === post.threadId &&
      document.revisionId === post.revisionId &&
      document.sha256 === post.sha256
    ) {
      for (const mediaId of document.mediaIds) bound.add(mediaId);
    }
  }
  if (bound.size === 0) return images;
  const declared = new Set(post.mediaIds);
  for (const image of media.images) {
    if (image.containerId === post.threadId && declared.has(image.id) && bound.has(image.id) && !images.has(image.id))
      images.set(image.id, image);
  }
  return images;
}

/** Local edits and newly returned replies cannot borrow a previous page's image summaries. */
export function documentImageForPost(
  media: ThreadDocumentMedia | undefined,
  post: ThreadPost,
  mediaId: string,
  pageIndex = 0,
): DocumentImagePresentation | null {
  return documentImagesForPost(media, post, pageIndex).get(mediaId) ?? null;
}
