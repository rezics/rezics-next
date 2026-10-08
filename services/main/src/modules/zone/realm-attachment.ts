import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type AdmissionRequest, type VerifiedPrincipal } from '../access/admission.ts';
import { REALM_ATTACH_ACTION, realmAttachScope } from './realm-attachment-authority.ts';

export class ZoneRealmAttachmentDenied extends Error {}

export type RealmAttachRequest = Pick<AdmissionRequest, 'principal' | 'actingSubject' | 'action' | 'scope'>;
export const realmAttachRequest = (principal: VerifiedPrincipal, actingSubject: string,
  realm: string): RealmAttachRequest => ({ principal, actingSubject,
  action: REALM_ATTACH_ACTION, scope: realmAttachScope(realm) });

/** Judge the Realm side through the Access registry's ordinary policy, exactly
 * as an admission would, without retaining one. A denial and an expiry read as
 * "not held"; an unavailable Access stays an error. */
export async function realmAttachHeld(access: Partial<Pick<AccessAdmissionRegistry, 'assertAuthority'>>,
  request: RealmAttachRequest): Promise<boolean> {
  if (!access.assertAuthority) return false;
  try { await access.assertAuthority(request); return true; }
  catch (error) {
    if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) return false;
    throw error;
  }
}
