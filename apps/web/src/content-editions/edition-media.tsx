import type { KernelClient } from '@rezics/client';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { ComponentType } from 'react';
import { m } from '../paraglide/messages.js';

/** Consumer-local declaration of the original media contract while its producer is absent. */
export type DocumentImagePresentation = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly { format: 'avif' | 'webp'; width: number; height: number }[];
  placeholder: { thumbhash: string; color: string } | null;
  focalPoint: { x: number; y: number } | null;
  credit: MediaImportRequest['credit'] | null;
}>;
export type DocumentMediaRead =
  | { kind: 'ready'; images: ReadonlyMap<string, DocumentImagePresentation> }
  | { kind: 'unavailable' };
type ImageProps = { image: DocumentImagePresentation | null; alt: string; locale: string };
type SharedDocumentMedia = {
  loadDocumentMedia(client: KernelClient, ids: readonly string[], authorization?: string): Promise<DocumentMediaRead>;
  NativeDocumentImage: ComponentType<ImageProps>;
};

// Resolve only the original shared module, never a second media transport or renderer.
// Vite admits the missing producer as an empty glob; Bun reads that same path directly.
const shared = await (async (): Promise<SharedDocumentMedia | null> => {
  try {
    const modules = import.meta.glob<SharedDocumentMedia>('../threads/document-media.ts', { eager: true });
    return modules['../threads/document-media.ts'] ?? null;
  } catch {
    const source = '../threads/document-media.ts';
    try {
      return await import(/* @vite-ignore */ source);
    } catch {
      return null;
    }
  }
})();

export async function loadDocumentMedia(
  client: KernelClient,
  ids: readonly string[],
  authorization?: string,
): Promise<DocumentMediaRead> {
  if (!shared?.loadDocumentMedia) return { kind: 'unavailable' };
  try {
    return await shared.loadDocumentMedia(client, ids, authorization);
  } catch {
    return { kind: 'unavailable' };
  }
}

function UnavailableImage({ alt, locale }: ImageProps) {
  const label = m.content_edition_image_unavailable({}, { locale: locale as never });
  return (
    <span className="block rounded-xl bg-muted p-5 text-sm text-muted-foreground" role="img" aria-label={alt || label}>
      {label}
      {alt ? ` — ${alt}` : ''}
    </span>
  );
}

export const NativeDocumentImage = shared?.NativeDocumentImage ?? UnavailableImage;
