import { canonicalCandidate } from '../editorial-review/contract.ts';
import {
  attachRightsIdentities,
  planExport,
  type ExportPlan,
  type VerifiedExportMember,
  type LicenseScopeHook,
} from './planner.ts';
import { readWikiHistory } from '../wiki/history-read.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { WikiRevisionSet } from '../wiki/delta.ts';
import { ExportStale } from './readers.ts';

/** Use the sealed export-plan manifest, with an owner-verified journal pin.
 * Resolution links stay outside the exported historical content. */
export async function readWikiExport(
  work: MainWorkDependencies,
  principal: VerifiedPrincipal,
  actor: string,
  resource: string,
  revisions: WikiRevisionSet,
  position: { dataEpoch: string; sequence: string },
  useScope: ExportPlan['useScope'],
  rights?: LicenseScopeHook,
  scope?: import('../wiki/history-read.ts').WikiHistoryScope,
) {
  const { resolutions: _resolutions, ...history } = await readWikiHistory(
    work,
    principal,
    actor,
    resource,
    revisions,
    undefined,
    scope,
  );
  if (
    position.dataEpoch !== history.sourcePosition.dataEpoch ||
    position.sequence !== history.sourcePosition.sequence
  ) {
    throw new ExportStale('Wiki revision set position differs from the selection');
  }
  const data = { ...history, exportActor: actor, resource };
  const member: VerifiedExportMember = {
    sourceOwner: 'graph',
    sourceNamespace: 'wiki',
    sourceGrain: 'structure_revision',
    exactRef: resource,
    contentRevisionId: null,
    refDigest: canonicalCandidate(data).digest,
    ownerDataEpoch: position.dataEpoch,
    ownerSequence: position.sequence,
    sourcePosition: history.revisionSetDigest,
    targetGrain: 'WikiRevisionSet',
    mapping: 'exact',
    data,
  };
  const members = await attachRightsIdentities(
    [member],
    [
      {
        material: {
          scopeKind: 'content_variant',
          provider: null,
          namespace: null,
          sourceRecordId: null,
          contentVariantId: resource,
          mediaAsset: null,
          component: 'structure',
        },
        target: { owner: 'graph', resource, component: 'structure', revision: resource },
      },
    ],
  );
  return planExport(
    { targetProfile: 'rezics-wiki-v1', useScope, members, residuals: [] },
    rights ??
      (async () => [
        {
          basisKind: 'unprotected_fact',
          basisRef: null,
          licenseExpression: null,
          notice: null,
          obligations: [],
          useScope,
          result: 'undetermined',
          memberOrdinals: [1],
        },
      ]),
  );
}
