export type AuthorErasureAdmission = { kind: 'current'; mayErase: boolean } | { kind: 'unavailable' };

/** Consumer-local unavailable adapter. Current thread/post DTOs declare no native mayErase admission.
 * Replace this adapter with that producer's read when delivered; authorId and edit/delete flags cannot supply it.
 * This signal controls presentation only. The native command always rechecks current post:erase.
 */
export function currentAuthorErasureAdmission(): AuthorErasureAdmission {
  return { kind: 'unavailable' };
}
