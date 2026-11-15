import { DOCUMENT_MEDIA_LIMIT } from '../threads/document-media-limit';

/** The producer's request bound never becomes a document-wide preview limit. */
export async function readImagePresentationBatches<T extends { id: string }>(
  ids: readonly string[],
  read: (ids: string[]) => Promise<{ kind: 'ready' | 'unavailable'; images: readonly T[] }>,
  publish: (settled: readonly string[], images: readonly T[]) => void,
  current: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (current() && next < ids.length) {
      const from = next;
      next += DOCUMENT_MEDIA_LIMIT;
      const batch = ids.slice(from, from + DOCUMENT_MEDIA_LIMIT);
      let images: readonly T[] = [];
      try {
        const result = await read(batch);
        if (result.kind === 'ready') images = result.images.filter((image) => batch.includes(image.id));
      } catch {
        /* A failed batch marks only its own references unavailable. */
      }
      if (current()) publish(batch, images);
    }
  };
  await Promise.all([worker(), worker()]);
}
