import type { FilterDocument } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { WorkClient } from '../work/client.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import type { CollectionPreview, PreviewParent } from './collection-preview.ts';
import { createMembersPreparation } from './members-preparation.ts';

type Parent = PreviewParent & { curatorAccountId: string | null };
export type PreviewPreparationDependencies = PresentationDependencies & { workClient?: () => Promise<WorkClient> };

/** The one common preparation owner supplies storage, intent atomicity and default continuation.
 * No result/read protocol is declared by MembersPreparation yet. Reservation is never read authority.
 */
export function createCollectionPreviewPreparation(deps: PreviewPreparationDependencies) {
  let after: string | null = null;
  return async (actor: Actor, parents: readonly Parent[], previews: ReadonlyMap<string, CollectionPreview>, deadline: number) => {
    if (actor.kind !== 'account' || !deps.workClient) return;
    const unresolved = parents.filter((parent) => parent.membershipKind === 'curated' &&
      parent.curatorAccountId === actor.accountId && previews.get(parent.id)?.previewStatus === 'pending')
      .sort((a, b) => a.id.localeCompare(b.id));
    const selected = unresolved.find((parent) => after === null || parent.id > after) ?? unresolved[0];
    if (!selected) return;
    // Advance even on unavailable admission, so one unresolved parent cannot monopolize this reader.
    after = selected.id;
    const release = await activeRelease(deps.pool);
    if (!release) return;
    const type = Object.keys(release.release.types).sort()[0];
    if (!type) return;
    // A shared-filter tautology selects all subjects with definitive current Type evidence.
    // Unknown stays unknown under NOT; this never manufactures coverage or a successful empty result.
    const leaf: FilterDocument = { type: { in: [type] } };
    const filter: FilterDocument = { or: [leaf, { not: leaf }] };
    try {
      const preparation = createMembersPreparation({ ...deps, workClient: await deps.workClient() });
      // One genuine mutation total for this list. No per-parent enqueue or synchronous continuation.
      await preparation.reserve(actor, selected.id, [{
        filter, sort: 'ordinal', release: { digest: release.digest, value: release.release },
      }], { deadline });
    } catch (error) {
      if (!(error instanceof ProblemError) || error.code !== 'dependency_unavailable') throw error;
      // Explicit producer unavailability leaves the entire preview pending, never partial/ready.
    }
  };
}
