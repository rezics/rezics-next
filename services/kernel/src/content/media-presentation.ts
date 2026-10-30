import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Actor } from '../request/access.ts';
import type { DownloadContext } from './media-download.ts';
import type { MediaDependencies } from './media.ts';

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
export type DocumentMediaPage = Readonly<{ images: readonly DocumentImagePresentation[] }>;

export declare function readDocumentMediaPresentations(
  deps: MediaDependencies,
  actor: Actor,
  ids: readonly string[],
  context: DownloadContext,
): Promise<DocumentMediaPage>;
