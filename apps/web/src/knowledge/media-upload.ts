import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import type { ImageUploader } from '@rezics/editor';
import {
  createMediaReservationIntent,
  uploadKnowledgeImage,
  resumeKnowledgeImageUpload,
  type MediaReservationIntent,
} from '../threads/upload';
import { createKnowledgeImageUploader } from './media';
import { parseKnowledgeMediaSource } from '@rezics/definitions/knowledge-media';

export type KnowledgeImageUploadBinding = {
  documentId: string;
  viewer: string;
  csrfToken: string;
  lifetime: string;
  current: () => boolean;
};
type Episode = { intent: MediaReservationIntent; mediaId?: string };

/** One credential/document visit reuses the original Media command per editor attachment and File. */
export function useKnowledgeImageUploader(
  body: DocumentSnapshot,
  binding: KnowledgeImageUploadBinding | null,
): {
  upload: ImageUploader | undefined;
  ownedOriginal: (source: string) => { src: string; width?: number; height?: number } | null;
} {
  const draft = useRef(body),
    live = useRef(binding);
  draft.current = body;
  live.current = binding;
  const key = binding ? JSON.stringify([binding.documentId, binding.viewer, binding.csrfToken, binding.lifetime]) : '';
  const owner = useMemo(() => ({ key, active: true }), [key]);
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  const [previewVersion, setPreviewVersion] = useState(0);
  const native = useMemo(() => {
    const previews = new Map<string, { width?: number; height?: number }>();
    if (!binding) return { upload: undefined, previews, current: () => false };
    const expected = binding;
    const episodes = new WeakMap<File, Map<string, Episode>>();
    const current = () =>
      owner.active &&
      live.current !== null &&
      JSON.stringify([live.current.documentId, live.current.viewer, live.current.csrfToken, live.current.lifetime]) ===
        owner.key &&
      live.current.current();
    const upload = createKnowledgeImageUploader({
      documentId: binding.documentId,
      readBody: () => draft.current,
      current,
      upload: async (documentId, file, signal, occurrence) => {
        let attempts = episodes.get(file);
        if (!attempts) {
          attempts = new Map();
          episodes.set(file, attempts);
        }
        const id = occurrence?.id ?? crypto.randomUUID();
        let episode = attempts.get(id);
        if (!episode) {
          episode = {
            intent: createMediaReservationIntent(
              { containerId: documentId },
              file,
              'knowledge-image',
              expected.viewer,
              expected.csrfToken,
            ),
          };
          attempts.set(id, episode);
        }
        const original = episode;
        const options = {
          reservation: original.intent,
          onStage: (_stage: unknown, mediaId?: string) => {
            if (mediaId) original.mediaId = mediaId;
          },
        };
        const image = await (original.mediaId
          ? resumeKnowledgeImageUpload(documentId, original.mediaId, file, signal, options)
          : uploadKnowledgeImage(documentId, file, signal, options));
        if (current() && !signal.aborted) {
          previews.set(image.src, {
            ...(image.width ? { width: image.width } : {}),
            ...(image.height ? { height: image.height } : {}),
          });
          while (previews.size > 32) previews.delete(previews.keys().next().value!);
          setPreviewVersion((value) => value + 1);
        }
        return image;
      },
    });
    return { upload, previews, current };
  }, [owner]);
  const ownedOriginal = useMemo(
    () => (source: string) => {
      if (!native.current()) return null;
      const parsed = parseKnowledgeMediaSource(source),
        preview = native.previews.get(source);
      return parsed?.selection === null && preview
        ? { src: `/media/${encodeURIComponent(parsed.mediaId)}/original`, ...preview }
        : null;
    },
    [native, previewVersion],
  );
  return { upload: native.upload, ownedOriginal };
}
