import { ContentUnavailable, type ExactContentReference } from '../../../../content/src/core.ts';
import type { RightsStore } from '../rights/store.ts';

/** A withdrawn assessment suppresses its text even though the revision is immutable. */
export async function publicDomainRevisionCurrent(
  reference: ExactContentReference,
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>,
): Promise<boolean> {
  if (reference.provenance.kind !== 'admitted-public-domain-v1') return true;
  const assessmentId = reference.provenance.rightsAssessmentId;
  if (typeof assessmentId !== 'string' || !rights) return false;
  try { return await rights.currentPublicDomainAssessment(reference.resourceId, assessmentId); }
  catch { throw new ContentUnavailable('current public-domain assessment is unavailable'); }
}
