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
import { ExportSourceNotFound, ExportSourceUnavailable, ExportStale } from './readers.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { MediaUnavailable } from '../media/store.ts';

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
  rights: LicenseScopeHook,
  scope?: import('../wiki/history-read.ts').WikiHistoryScope,
) {
  const read = async () => {
    try {
      // One bounded disclosure session covers the complete export inventory,
      // rather than retaining an earlier page after a later-page revocation.
      const {
        resolutions: _resolutions,
        nextCursor: _cursor,
        ...history
      } = await readWikiHistory(
        work,
        principal,
        actor,
        resource,
        revisions,
        undefined,
        scope,
        { all: true },
        'export',
      );
      return history;
    } catch (error) {
      if (error instanceof WorkReadMissing)
        throw new ExportSourceNotFound('Selected source is unavailable', { cause: error });
      if (error instanceof WorkReadMoved)
        throw new ExportStale('Wiki changed during export disclosure', { cause: error });
      if (error instanceof WorkReadUnavailable || error instanceof MediaUnavailable)
        throw new ExportSourceUnavailable('Wiki disclosure is unavailable', { cause: error });
      throw error;
    }
  };
  const history = await read();
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
  const plan = await planExport(
    { targetProfile: 'rezics-wiki-v1', useScope, members, residuals: [] },
    rights,
  );
  if (canonicalCandidate(await read()).digest !== canonicalCandidate(history).digest)
    throw new ExportStale('Wiki disclosure changed during export planning');
  return plan;
}
