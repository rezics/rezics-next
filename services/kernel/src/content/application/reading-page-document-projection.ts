import type {
  ReadingPageBoundPresentation,
  ProjectedReadingPageDocumentMedia,
  ProjectedReadingPageImage,
  SelectedReadingPageMedia,
} from '../contract/index.ts';

/** First matching presentation wins; missing or foreign images stay per-image unavailable. */
export function projectReadingPageDocumentMedia<T extends ReadingPageBoundPresentation>(
  selection: SelectedReadingPageMedia,
  presentations: readonly T[],
): ProjectedReadingPageDocumentMedia<T> {
  const allowed = new Set(selection.mediaIds);
  const byId = new Map<string, T>();
  for (const image of presentations) {
    if (!allowed.has(image.id) || byId.has(image.id)) continue;
    byId.set(image.id, image);
  }
  return {
    state: 'available',
    documents: selection.documents.map((document) => {
      const images = document.mediaIds.map<ProjectedReadingPageImage<T>>((id) => {
        const presentation = byId.get(id);
        return presentation?.containerId === document.threadId
          ? { id, state: 'available', presentation }
          : { id, state: 'unavailable' };
      });
      return {
        postId: document.postId,
        threadId: document.threadId,
        revisionId: document.revisionId,
        sha256: document.sha256,
        state: images.some((image) => image.state === 'available') ? 'available' : 'unavailable',
        images,
      };
    }),
  };
}
