import {
  READING_PAGE_DOCUMENT_LIMIT,
  READING_PAGE_DOCUMENT_MEDIA_LIMIT,
  type ReadingPageNode,
  type ReadingPagePost,
  type ReadingPageDocumentSelection,
  type SelectedReadingPageDocument,
  type ReadingPageBoundPresentation,
  type ReadingPageDocumentPort,
  type ReadingPageDocumentMedia,
} from '../contract/index.ts';
import { projectReadingPageDocumentMedia } from './reading-page-document-projection.ts';

function referencedImages(
  document: ReadingPageNode,
  declared: ReadonlySet<string>,
  isRoutedId: (id: string) => boolean,
): string[] {
  const ids = new Set<string>();
  const pending = [document];
  while (pending.length && ids.size <= READING_PAGE_DOCUMENT_MEDIA_LIMIT) {
    const node = pending.pop()!;
    const source = node.type === 'image' ? node.attrs?.src : undefined;
    if (typeof source === 'string' && declared.has(source) && isRoutedId(source)) ids.add(source);
    for (const child of node.content ?? []) pending.push(child);
  }
  return [...ids];
}

/** Select only declared image IDs in the current readable documents of one native page. */
export function selectReadingPageDocumentMedia(
  threadId: string,
  posts: readonly ReadingPagePost[],
  isRoutedId: (id: string) => boolean,
): ReadingPageDocumentSelection {
  if (posts.length > READING_PAGE_DOCUMENT_LIMIT) throw new RangeError('Reading page document bound exceeded');
  const selected: SelectedReadingPageDocument[] = [];
  const allIds = new Set<string>();
  for (const post of posts) {
    if (post.availability !== 'available' || post.threadId !== threadId || !post.revisionId) continue;
    const declared = new Set((post.mediaIds ?? []).filter(isRoutedId));
    const mediaIds = referencedImages(post.body!.doc, declared, isRoutedId);
    if (!mediaIds.length) continue;
    selected.push({
      postId: post.id,
      threadId: post.threadId,
      revisionId: post.revisionId,
      sha256: post.sha256!,
      mediaIds,
    });
    for (const id of mediaIds) {
      allIds.add(id);
      if (allIds.size > READING_PAGE_DOCUMENT_MEDIA_LIMIT) break;
    }
  }
  if (allIds.size > READING_PAGE_DOCUMENT_MEDIA_LIMIT) return { state: 'overflow', documents: selected };
  return { state: 'selected', documents: selected, mediaIds: [...allIds] };
}

function unavailableDocument(document: SelectedReadingPageDocument) {
  return {
    postId: document.postId,
    threadId: document.threadId,
    revisionId: document.revisionId,
    sha256: document.sha256,
    state: 'unavailable' as const,
    images: [] as const,
  };
}

/** Native optional composition runs before ReadingPage's final source admission. */
export async function readReadingPageDocumentMedia<T extends ReadingPageBoundPresentation>(
  port: ReadingPageDocumentPort<T>,
  selection: ReadingPageDocumentSelection,
): Promise<ReadingPageDocumentMedia<T>> {
  if (selection.state === 'overflow')
    return {
      state: 'overflow',
      documents: selection.documents.map((document) => ({
        ...unavailableDocument(document),
        state: 'overflow' as const,
      })),
    };
  if (!selection.documents.length) return { state: 'available', documents: [] };
  const presentations = await port.read(selection.mediaIds);
  if (presentations.state === 'unavailable')
    return { state: 'unavailable', documents: selection.documents.map(unavailableDocument) };
  return projectReadingPageDocumentMedia(selection, presentations.value);
}
