import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MISSING_MEDIA_BOUNDARY, type MediaBoundary } from '../services/kernel/test/imports/media-boundary.ts';

export interface MediaBoundaryDriver {
  boundary: MediaBoundary;
  /** Separate identity fixture owns the actual actor/token. No claims or token minting here. */
  importerId: string;
  /** Created via ordinary public commands by the full API assembly, never media SQL seeds. */
  containerId: string;
  /** Ordinary authenticated portable JSON client; it never fetches image bytes. */
  request(input: MediaImportRequest, key: string): Promise<{ status: number; body: unknown }>;
  status(mediaId: string): Promise<{ status: number; body: MediaImportStatus }>;
  disclose(mediaId: string): Promise<{ status: number; headers: Headers; bytes: Uint8Array; url: string }>;
  /** Include external fixtures; process-wide worker lifetime belongs to the assembly. */
  close(): Promise<void>;
}

/**
 * Private full-assembly adapter, not a public API/worker contract. The eventual
 * module exports createMediaBoundaryDriver using createMediaBoundary from the
 * kernel test fixture. Supply that fixture's configuration to production content
 * composition when createKernel supports it; do not cast an invented content slot.
 * No identity/bootstrap/routes, fake job success or module-local worker here.
 * Existing API/media-resolver suites remain unchanged and own their outcomes.
 */
export async function loadMediaBoundaryDriver(): Promise<MediaBoundaryDriver> {
  const path = process.env.IMPORT_MEDIA_BOUNDARY_DRIVER;
  if (!path) throw new Error(MISSING_MEDIA_BOUNDARY);
  const url = isAbsolute(path) ? pathToFileURL(path) : new URL(path);
  if (url.protocol !== 'file:') throw new Error('IMPORT_MEDIA_BOUNDARY_DRIVER must use an absolute file path');
  const module: { createMediaBoundaryDriver(): Promise<MediaBoundaryDriver> } = await import(url.href);
  return module.createMediaBoundaryDriver();
}
