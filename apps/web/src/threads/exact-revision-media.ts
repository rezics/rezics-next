import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import {
  DOCUMENT_MEDIA_LIMIT,
  loadDocumentMedia,
  type DocumentImagePresentation,
  type DocumentMediaRead,
} from './document-media';

/** Keep the original result in a concrete Map supported by the server-function serializer. */
export async function loadRevisionDocumentMedia(...args: Parameters<typeof loadDocumentMedia>) {
  const media = await loadDocumentMedia(...args);
  return media.kind === 'ready' ? { ...media, images: new Map(media.images) } : media;
}
export type RevisionDocumentMedia = Awaited<ReturnType<typeof loadRevisionDocumentMedia>>;

type RevisionImageSource = Readonly<{
  availability: string;
  body: DocumentSnapshot | null;
  mediaIds: readonly string[];
}>;

/** Only original IDs declared by, and actually referenced in, this delivered document page. */
export function revisionDocumentImageIds(revisions: readonly RevisionImageSource[]): string[] {
  const ids = new Set<string>();
  for (const revision of revisions) {
    if (revision.availability !== 'available' || !revision.body) continue;
    const declared = new Set(revision.mediaIds);
    const visit = (node: DocumentNode) => {
      if (ids.size === DOCUMENT_MEDIA_LIMIT) return;
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && declared.has(node.attrs.src))
        ids.add(node.attrs.src);
      for (const child of node.content ?? []) {
        if (ids.size === DOCUMENT_MEDIA_LIMIT) break;
        visit(child);
      }
    };
    visit(revision.body.doc);
    if (ids.size === DOCUMENT_MEDIA_LIMIT) break;
  }
  return [...ids];
}

/** A page's independent media result applies only to a readable revision's own declared container reference. */
export function revisionDocumentImage(
  media: DocumentMediaRead,
  revision: RevisionImageSource & { threadId: string },
  mediaId: string,
): DocumentImagePresentation | null {
  if (
    media.kind !== 'ready' ||
    revision.availability !== 'available' ||
    !revision.body ||
    !revision.mediaIds.includes(mediaId)
  )
    return null;
  const image = media.images.get(mediaId);
  return image?.containerId === revision.threadId ? image : null;
}
