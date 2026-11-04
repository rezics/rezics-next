import { AuthenticationError, type Actor } from '../request/access.ts';
import type { ModerationDirectoryInput, ModerationDirectoryPage } from './moderation-directory-schemas.ts';

/** Named local dependency seam. Access's current-resource-roles accepts a known
 * resource; Accounts has no admitted actor-resource coverage source on this base.
 * An absent source cannot certify an empty directory or any current permission.
 */
export async function nativeModerationCandidateReferencesUnavailable(): Promise<ModerationDirectoryPage> {
  return { state: 'unavailable', items: [], next: null };
}

/** Mounted producer boundary, ready for the shared complete-input publisher.
 * Keep exact manual queue reads independent while native coverage is unavailable.
 */
export async function readNativeModerationDirectory(
  actor: Actor,
  input: ModerationDirectoryInput,
): Promise<ModerationDirectoryPage> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
    throw new RangeError('Moderation directory limit must be 1 to 20');
  return nativeModerationCandidateReferencesUnavailable();
}
