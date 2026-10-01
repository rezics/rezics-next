import { AdmissionDenied, AdmissionUnavailable } from '../access/admission.ts';
import type { Blocker, OwnerCommand } from './contract.ts';
import type { EditorialRuntime } from './runtime.ts';

/** De-duplicate exact action/scope probes; owner requirements remain bounded by
 * the candidate's command ceiling. No decision permit or owner effect is issued. */
export async function ownerAuthorityBlockers(runtime: EditorialRuntime, agent: string,
  requirements: readonly Pick<OwnerCommand, 'action' | 'scope'>[], publicationWork?: string | null): Promise<Blocker[]> {
  if (!runtime.work.access.assertAuthority) return [{ code: 'owner_unavailable' }];
  const principal = await runtime.work.account.verify(runtime.request,['work:read']);
  const blockers: Blocker[] = [];
  const unique = new Map(requirements.map(({ action,scope }) => [JSON.stringify([action,scope]),{ action,scope }]));
  for (const requirement of unique.values()) {
    const request = { ...requirement,principal,actingSubject: agent,
      idempotencyKey: 'authority-probe',requestDigest: '0'.repeat(64) };
    try {
      await runtime.work.access.assertAuthority(request,publicationWork);
    } catch (error) {
      if (error instanceof AdmissionDenied) blockers.push({ code: 'owner_authority_required',...requirement });
      else if (error instanceof AdmissionUnavailable) blockers.push({ code: 'owner_unavailable' });
      else throw error;
    }
  }
  return blockers;
}
