import type { KernelClient } from '@rezics/client';
import type { DocumentNode } from '@rezics/document';
import { DOCUMENT_MEDIA_LIMIT, loadDocumentMedia, type DocumentImagePresentation } from './document-media';
import type { ThreadPost } from './thread-page';

type DocumentBinding = Readonly<{
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

export async function readThreadDocumentMedia(
  client: KernelClient,
  posts: readonly ThreadPost[],
  authorization?: string | null,
): Promise<ThreadDocumentMedia> {
  const ids = new Set<string>();
  const documents: DocumentBinding[] = [];
  for (const post of posts) {
    if (post.availability !== 'available') continue;
    const declared = new Set(post.mediaIds);
    const referenced = new Set<string>();
    function visit(node: DocumentNode) {
      if (ids.size > DOCUMENT_MEDIA_LIMIT) return;
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && declared.has(node.attrs.src)) {
        ids.add(node.attrs.src);
        referenced.add(node.attrs.src);
      }
      for (const child of node.content ?? []) visit(child);
    }
    visit(post.body.doc);
    // Overflow keeps every body readable and makes all images unavailable, without truncation or a second batch.
    if (ids.size > DOCUMENT_MEDIA_LIMIT) return { kind: 'unavailable', reason: 'overflow' };
    if (referenced.size)
      documents.push({
        postId: post.id,
        threadId: post.threadId,
        revisionId: post.revisionId,
        sha256: post.sha256,
        mediaIds: [...referenced],
      });
  }
  const result = await loadDocumentMedia(client, [...ids], authorization);
  if (result.kind === 'unavailable') return result;
  return {
    kind: 'ready',
    documents,
    images: [...result.images.values()].filter((image) =>
      documents.some((document) => document.threadId === image.containerId && document.mediaIds.includes(image.id)),
    ),
  };
}

/** Local edits and newly returned replies cannot borrow a previous page's image summaries. */
export function documentImageForPost(
  media: ThreadDocumentMedia | undefined,
  post: ThreadPost,
  mediaId: string,
): DocumentImagePresentation | null {
  if (media?.kind !== 'ready' || post.availability !== 'available' || !post.mediaIds.includes(mediaId)) return null;
  const binding = media.documents.find(
    (document) =>
      document.postId === post.id &&
      document.threadId === post.threadId &&
      document.revisionId === post.revisionId &&
      document.sha256 === post.sha256 &&
      document.mediaIds.includes(mediaId),
  );
  return binding
    ? (media.images.find((image) => image.id === mediaId && image.containerId === post.threadId) ?? null)
    : null;
}
