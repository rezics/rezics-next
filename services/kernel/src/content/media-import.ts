import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';

/** Trusted host configuration, never accepted as caller JSON. Runtime must
 * revalidate exact HTTPS hosts on every redirect and enforce fetch bounds.
 */
export type MediaImportFetchConfig = Readonly<{ allowedHosts: readonly string[] }>;
export interface MediaImportDependencies {
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock: () => Date;
  fetchConfig: MediaImportFetchConfig;
}
export type MediaImportContext = Readonly<{ deadline: number; idempotencyKey: string; requestId: string }>;

/** Reserve in the command transaction. Cover claims remain in their caller's
 * command transaction; this port grants no publication permission.
 */
export async function importMediaFromUrl(
  _deps: MediaImportDependencies,
  _actor: Actor,
  _input: MediaImportRequest,
  _context: MediaImportContext,
): Promise<CommandOutcome<{ mediaId: string }>> {
  throw new Error('importMediaFromUrl is not implemented');
}

/** GET media/{id}:importStatus must use media:read_reservation, the current
 * uploader formula and denials, with no anonymous fallback. Hidden/unknown
 * objects have the same null result. This port exposes no HTTP handler.
 */
export async function readMediaImportStatus(
  _deps: MediaImportDependencies,
  _actor: Actor,
  _id: string,
  _context: Readonly<{ deadline: number }>,
): Promise<MediaImportStatus | null> {
  throw new Error('readMediaImportStatus is not implemented');
}
