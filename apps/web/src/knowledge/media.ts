import {
  knowledgeMediaQuery,
  knowledgeMediaSource,
  parseKnowledgeMediaSelection,
  parseKnowledgeMediaSource,
  type KnowledgeMediaSelection,
} from '@rezics/definitions/knowledge-media';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { ImageUploader } from '@rezics/editor';
import { validVariant } from '../media/cover-src';

export const KNOWLEDGE_IMAGE_LIMIT = 32;

/** One bounded metadata index. Stored image attrs and their original source contexts are never rewritten. */
export function knowledgeImageSources(body: DocumentSnapshot): { sources: readonly string[]; overflow: boolean } {
  const sources = new Set<string>();
  let overflow = false;
  function visit(node: DocumentNode) {
    if (overflow) return;
    if (node.type === 'image' || node.type === 'media') {
      const value = node.attrs?.src;
      if (typeof value === 'string' && parseKnowledgeMediaSource(value)) {
        sources.add(value);
        if (sources.size > KNOWLEDGE_IMAGE_LIMIT) {
          overflow = true;
          return;
        }
      }
    }
    for (const child of node.content ?? []) visit(child);
  }
  visit(body.doc);
  return { sources: overflow ? [] : [...sources], overflow };
}

/** Only the admitted private revision digest can establish an authoring source; never hash the local draft. */
export function knowledgeAuthoringImageSelection(head: {
  documentId: string;
  revisionId: string;
  sha256?: string;
}): KnowledgeMediaSelection | null {
  return parseKnowledgeMediaSelection({
    representation: 'authoring',
    documentId: head.documentId,
    revisionId: head.revisionId,
    sourceSha256: head.sha256,
  });
}

/** A bare authored locator can use only its saved owner's source; explicit references retain their own context. */
export function knowledgeImageSelection(
  src: string,
  own?: KnowledgeMediaSelection | null,
): KnowledgeMediaSelection | null {
  const parsed = parseKnowledgeMediaSource(src);
  if (!parsed) return null;
  if (parsed.selection) return parsed.selection;
  return own?.representation === 'authoring' && parseKnowledgeMediaSelection(own) ? own : null;
}

/** Variant names must come from admitted presentation metadata, never from a guessed image width. */
export function knowledgeImageHref(src: string, variant: string, own?: KnowledgeMediaSelection | null): string | null {
  const parsed = parseKnowledgeMediaSource(src),
    selection = knowledgeImageSelection(src, own);
  if (!parsed || !selection || !validVariant(variant)) return null;
  return `/media/${encodeURIComponent(parsed.mediaId)}/${encodeURIComponent(variant)}?${new URLSearchParams(knowledgeMediaQuery(selection))}`;
}

export type KnowledgeImageUploadPort = (
  documentId: string,
  file: File,
  signal: AbortSignal,
  occurrence?: Parameters<ImageUploader>[2],
) => Promise<Awaited<ReturnType<ImageUploader>>>;

/** The shared uploader owns reservation, bytes, completion and recovery; this host only emits the claim URI. */
export function createKnowledgeImageUploader({
  documentId,
  readBody,
  current,
  upload,
}: {
  documentId: string;
  readBody: () => DocumentSnapshot;
  current: () => boolean;
  upload: KnowledgeImageUploadPort;
}): ImageUploader {
  // Validate before exposing a native upload action. A new unsaved document has no upload container.
  knowledgeMediaSource(documentId);
  const pending = new Set<symbol>();
  return async (file, signal, occurrence) => {
    if (!current() || signal.aborted) throw new DOMException('The Knowledge upload visit ended', 'AbortError');
    const images = knowledgeImageSources(readBody());
    if (images.overflow || images.sources.length + pending.size >= KNOWLEDGE_IMAGE_LIMIT)
      throw new Error('Knowledge managed image limit reached');
    const attempt = Symbol();
    pending.add(attempt);
    try {
      const image = await upload(documentId, file, signal, occurrence);
      if (!current() || signal.aborted) throw new DOMException('The Knowledge upload visit ended', 'AbortError');
      const source = parseKnowledgeMediaSource(image.src);
      if (!source || source.selection !== null) throw new Error('Knowledge uploader returned an invalid claim URI');
      return image;
    } finally {
      pending.delete(attempt);
    }
  };
}
