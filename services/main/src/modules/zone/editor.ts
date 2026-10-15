import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AdmissionDenied } from '../access/admission.ts';
import { AccountAssertionInsufficientScope } from '../account/verify-assertion.ts';
import { ZoneUnavailable } from './configuration.ts';

/** Saved configuration and navigation are previews; semantic reading supplies
 * no edit mandate. Every preview surface reuses this live owner decision. */
export async function requireZoneEditor(work: Pick<MainWorkDependencies, 'account' | 'access'>,
  request: Request, zone: string, actingSubject: string) {
  try {
    const principal = await work.account.verify(request, ['zone:edit']);
    if (!work.access.assertAuthority) throw new AdmissionDenied('Zone edit authority is unavailable');
    await work.access.assertAuthority({ principal, actingSubject, scope: `zone:edit:${zone}`, action: 'zone.edit' });
    return principal;
  } catch (error) {
    if (error instanceof AdmissionDenied || error instanceof AccountAssertionInsufficientScope) {
      throw new ZoneUnavailable('Zone is unavailable');
    }
    throw error;
  }
}
