import { ContentUnavailable, type ExactContentReference } from '../../../../content/src/core.ts';
import type { RightsStore } from '../rights/store.ts';
import type { PoolClient } from 'pg';

/** A withdrawn assessment suppresses its text even though the revision is immutable. */
export async function publicDomainRevisionCurrent(
  reference: ExactContentReference,
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>,
  client?: PoolClient,
): Promise<boolean> {
  if (reference.provenance.kind !== 'admitted-public-domain-v1') return true;
  const assessmentId = reference.provenance.rightsAssessmentId;
  if (typeof assessmentId !== 'string' || !rights) return false;
  try { return await rights.currentPublicDomainAssessment(reference.resourceId, assessmentId, client); }
  catch (cause) { throw new ContentUnavailable('current public-domain assessment is unavailable', { cause }); }
}

/** Page delivery shares the Rights owner's bounded current-head probe. */
export async function publicDomainRevisionsCurrent(
  references: readonly ExactContentReference[],
  rights?: Pick<RightsStore, 'currentPublicDomainAssessments'>,
): Promise<boolean[]> {
  const requests = references.flatMap(reference => reference.provenance.kind === 'admitted-public-domain-v1'
    && typeof reference.provenance.rightsAssessmentId === 'string'
    ? [{ work: reference.resourceId, assessmentId: reference.provenance.rightsAssessmentId }] : []);
  try {
    const current = rights && requests.length ? await rights.currentPublicDomainAssessments(requests) : new Set<string>();
    return references.map(reference => reference.provenance.kind !== 'admitted-public-domain-v1'
      || typeof reference.provenance.rightsAssessmentId === 'string'
        && current.has(`${reference.resourceId}\0${reference.provenance.rightsAssessmentId}`));
  } catch (cause) { throw new ContentUnavailable('current public-domain assessment is unavailable', { cause }); }
}
