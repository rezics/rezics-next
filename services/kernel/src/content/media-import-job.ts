import type { MediaImportDependencies } from './media-import.ts';
import type { MediaStorage } from './media-storage.ts';

export interface MediaImportJobDependencies extends MediaImportDependencies {
  storage: MediaStorage;
}
export type ImportedMediaOutcome =
  | Readonly<{ mediaId: string; state: 'available' }>
  | Readonly<{ mediaId: string; state: 'rejected'; rejection: { code: string } }>;

/** Internal import processing must measure bytes/type/hash and use guarded
 * native transitions. It does not invoke website media:complete.
 */
export async function processImportedMedia(
  _deps: MediaImportJobDependencies,
  _mediaId: string,
): Promise<ImportedMediaOutcome> {
  throw new Error('processImportedMedia is not implemented');
}
