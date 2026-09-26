import { createHash } from 'node:crypto';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readFixedRelease } from '../work/fixed-release.ts';
import { readAssessment, readClaimRevisions } from '../verification/graph.ts';
import type { VerificationStore } from '../verification/store.ts';
import { canonicalExport, planExport, type ExportLoss, type ExportPlan, type LicenseScopeHook,
  type VerifiedExportMember } from './planner.ts';

export class ExportStale extends Error {}
export class ExportSourceUnavailable extends Error {}

const sha = (value: unknown) => createHash('sha256').update(canonicalExport(value)).digest('hex');
const unknownRights: LicenseScopeHook = async (members, useScope) => [{ basisKind: 'unprotected_fact',
  basisRef: null, licenseExpression: null, notice: null, obligations: [], useScope,
  result: 'undetermined', memberOrdinals: members.map((_, index) => index + 1) }];

export type ExportSelection = { kind: 'fixed-release' | 'assessment'; reference: string;
  expectedPosition: { dataEpoch: string; sequence: string } };

export interface ExportReaderDependencies {
  env: WorkActivationEnvironment;
  canReadWork: (principal: VerifiedPrincipal, actingSubject: string, work: string) => Promise<boolean>;
  verification?: Pick<VerificationStore, 'readEvidence'>;
  rights?: LicenseScopeHook;
}

/** Exact readers decide the member payload. No caller-provided member or basis is trusted. */
export async function readExportPlan(deps: ExportReaderDependencies, principal: VerifiedPrincipal,
  actingSubject: string, selection: ExportSelection, useScope: ExportPlan['useScope']): Promise<ExportPlan> {
  if (selection.kind === 'fixed-release') {
    const release = await readFixedRelease(deps.env, selection.reference,
      work => deps.canReadWork(principal, actingSubject, work));
    if (release.sourcePosition.dataEpoch !== selection.expectedPosition.dataEpoch
      || release.sourcePosition.sequence !== selection.expectedPosition.sequence
      || release.sourcePosition.dataEpoch !== deps.env.lineage.dataEpoch) {
      throw new ExportStale('fixed release position differs from requested selection');
    }
    const { body: _body, ...metadata } = release;
    const exportedMetadata = { ...metadata, exportActor: actingSubject };
    const member: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
      sourceGrain: 'main_version', exactRef: release.mainRevision, contentRevisionId: null,
      refDigest: sha(exportedMetadata), ownerDataEpoch: release.sourcePosition.dataEpoch,
      ownerSequence: release.sourcePosition.sequence, sourcePosition: release.selection,
      targetGrain: 'MainVersion', mapping: 'exact', data: exportedMetadata };
    return planExport({ targetProfile: 'rezics-main-version-v1', useScope, members: [member],
      residuals: [
        { memberOrdinal: null, kind: 'missing_member', path: '/externalReleases',
          detail: { reason: 'No verified external release reader is installed' } },
        { memberOrdinal: 1, kind: 'rights_excluded', path: '/body',
          detail: { reason: 'Exact body was checked but this export has no body-use assessment' } },
      ] }, deps.rights ?? unknownRights);
  }
  if (!deps.verification) throw new ExportSourceUnavailable('verification owner is unavailable');
  const assessment = await readAssessment(deps.env, selection.reference);
  if (!assessment) throw new ExportSourceUnavailable('assessment is unavailable');
  if (assessment.dataEpoch !== selection.expectedPosition.dataEpoch
    || assessment.sequence !== selection.expectedPosition.sequence
    || assessment.dataEpoch !== deps.env.lineage.dataEpoch) {
    throw new ExportStale('assessment position differs from requested selection');
  }
  const claim = (await readClaimRevisions(deps.env, [assessment.claimRevision])).get(assessment.claimRevision);
  if (!claim || claim.claim !== assessment.claim) throw new ExportSourceUnavailable('claim revision is unavailable');
  const evidence = await deps.verification.readEvidence(assessment.evidenceSetRevision.split('/').at(-1)!);
  const evidenceItems = evidence?.items.map(item => ({ ordinal: item.ordinal,
    stance: item.stance, recordedAvailability: item.availability,
    currentAvailability: item.currentAvailability })) ?? [];
  const claimMember: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
    sourceGrain: 'claim', exactRef: assessment.claimRevision, contentRevisionId: null,
    refDigest: sha(claim), ownerDataEpoch: claim.dataEpoch, ownerSequence: claim.sequence,
    sourcePosition: null, targetGrain: 'Claim', mapping: 'exact', data: { ...claim } };
  const assessmentData = { ...assessment, exportActor: actingSubject,
    scoreKind: assessment.scorePerMillion === null
    ? null : 'method-output', evidence: evidence ? {
      revision: evidence.revision, manifestDigest: evidence.manifestDigest,
      itemCount: evidence.itemCount, items: evidenceItems } : null };
  const assessmentMember: VerifiedExportMember = { sourceOwner: 'graph', sourceNamespace: 'product',
    sourceGrain: 'assessment', exactRef: assessment.assessment, contentRevisionId: null,
    refDigest: sha(assessmentData), ownerDataEpoch: assessment.dataEpoch,
    ownerSequence: assessment.sequence, sourcePosition: assessment.evaluationContext,
    targetGrain: 'Assessment', mapping: 'exact', data: assessmentData };
  const residuals: ExportLoss[] = evidence ? evidence.items.map(item => ({ memberOrdinal: 2,
    kind: 'private_dependency' as const, path: `/evidence/items/${item.ordinal}/anchor`,
    detail: { reason: 'The cited anchor has no export disclosure proof' } }))
    : [{ memberOrdinal: 2, kind: 'unavailable' as const, path: '/evidence',
      detail: { reason: 'Exact evidence manifest is unavailable' } }];
  residuals.push({ memberOrdinal: 2, kind: 'unavailable', path: '/methodCalibration',
    detail: { reason: 'No representative labelled calibration record was verified for this method' } });
  return planExport({ targetProfile: 'rezics-verification-v1', useScope,
    members: [claimMember, assessmentMember], residuals }, deps.rights ?? unknownRights);
}
