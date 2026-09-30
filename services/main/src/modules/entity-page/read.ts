import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { MAX_SUMMARY_BATCH, readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import {
  capabilityBases,
  capabilityPath,
  type Base,
  type ResolvedTarget,
} from '../target/contract.ts';
import { resolveTargets, targetSummaryReader } from '../target/resolve.ts';
import { admittedTypes } from '../types/registry.ts';
import { readWorkHeader } from '../work/read-header.ts';
import { readWorkRating } from '../work/read-rating.ts';
import {
  WorkReadMissing,
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { entitySection, type SectionId } from './contract.ts';

// Stable anchors follow the Work hub order. Structural ownership binds sections;
// descriptive types can only select the registry's explicit presentation slots.
export const baseSections = {
  work: [
    'statements',
    'releases',
    'contents',
    'relations',
    'credits',
    'ratings',
    'reviews',
    'discussion',
    'lists',
  ],
  release: ['statements', 'relations', 'credits', 'ratings', 'reviews', 'discussion', 'lists'],
  realization: ['statements', 'relations', 'discussion', 'lists'],
  occurrence: ['statements', 'relations', 'discussion', 'lists'],
  resource: ['statements', 'relations', 'discussion', 'lists'],
} as const satisfies Record<Base, readonly SectionId[]>;

export function pageRegistry(target: Pick<ResolvedTarget, 'base' | 'types'>) {
  const registryBase =
    target.base === 'work' || target.base === 'resource' ? target.base : 'record';
  const entries = admittedTypes.filter(
    (entry) => entry.base === registryBase && target.types.includes(entry.type),
  );
  const selected =
    entries.sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type))[0] ??
    admittedTypes.find((entry) => entry.base === registryBase && entry.default);
  if (!selected) throw new WorkReadUnavailable('Target base has no registry default');
  return selected;
}

export function pageSections(target: ResolvedTarget): Static<typeof entitySection>[] {
  const registry = pageRegistry(target);
  const typeSection =
    target.base === 'work' && ['recipe', 'prompt', 'skill'].includes(registry.presentation)
      ? (registry.presentation as 'recipe' | 'prompt' | 'skill')
      : null;
  const sections: Static<typeof entitySection>[] = baseSections[target.base].map((id) => ({
    id,
    href:
      id === 'lists'
        ? capabilityPath(target.resource, 'collection-member')
        : capabilityPath(target.resource, id),
    actions: [],
  }));
  if (typeSection)
    sections.splice(1, 0, {
      id: typeSection,
      href: `/v1/${typeSection === 'recipe' ? 'recipes' : 'hub'}/works/${target.resource.slice(-36)}`,
      actions: [],
    });
  // The table is deliberately checked against capability admission, so future
  // base changes cannot accidentally add Work/release-only social sections.
  for (const section of sections) {
    const capability =
      section.id === 'ratings'
        ? 'rating'
        : section.id === 'reviews'
          ? 'review'
          : section.id === 'discussion'
            ? 'discussion'
            : section.id === 'lists'
              ? 'collection-member'
              : null;
    if (capability && !(capabilityBases[capability] as readonly Base[]).includes(target.base)) {
      throw new WorkReadUnavailable('Page section is not bound to its base');
    }
  }
  return sections;
}

export async function readEntityPage(session: WorkReadSession, resource: string) {
  const target = (await resolveTargets(session, [resource], 'discussion'))[0]!;
  // Resolve again after hydration: graph-position fences alone do not detect an
  // Access revocation. Use G-506's reader, including semantic/Context grants.
  const summaryBatch = await resolveSummary(session, target.resource);
  const registry = pageRegistry(target);
  const sections = pageSections(target);
  const work = target.base === 'work' ? await readWorkHeader(session, target.resource) : null;
  if (
    work?.disclosure === 'public' &&
    session.deps.access.readRatingAggregateInventory &&
    session.deps.access.checkRatingAggregateFence
  ) {
    try {
      const rating = await readWorkRating(session, resource);
      if (rating.status === 'available' && rating.context) {
        sections.find((section) => section.id === 'ratings')!.count = {
          value: rating.count,
          precision: 'exact',
          context: rating.context,
          target: rating.mainVersion,
        };
      }
    } catch (error) {
      // Several questions/populations have no single default total. The owner
      // inventory remains linked; a page never chooses a misleading count.
      if (!(error instanceof WorkReadInvalid)) throw error;
    }
  }
  if (work && session.principal && session.options.actingSubject) {
    try {
      const principal = await session.deps.account.verify(session.request, ['work:edit']);
      if (
        await session.deps.access.canEditWork(principal, session.options.actingSubject, resource)
      ) {
        for (const section of sections)
          if (['contents', 'releases'].includes(section.id)) {
            section.actions.push('work.edit');
          }
      }
    } catch (error) {
      if (!(error instanceof AccountAssertionDenied)) throw error;
    }
  }
  await resolveTargets(session, [target.resource], 'discussion');
  return {
    profile: 'entity-page-v1' as const,
    target,
    summary: summaryBatch,
    registry,
    work,
    sections,
    sourcePosition: session.position,
  };
}

export async function resolveSummary(session: WorkReadSession, resource: string) {
  // A target-only resolve intentionally returns no presentation metadata. Reuse
  // the same summary owner with semantic authority rather than Work-only summaries.
  const result = await readResourceSummaries(
    session.deps.environment,
    session.deps.media?.store,
    targetSummaryReader(session),
    {
      resources: [resource],
      context: DEFAULT_MEDIA_CONTEXT,
      language: session.options.language ?? null,
      languages: session.displayLanguages,
    },
  );
  if (result.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
    throw new WorkReadMoved('Graph changed during page summary hydration');
  }
  const summary = result.summaries[0]!;
  if (summary.status !== 'available') throw new WorkReadMissing('Resource is unavailable');
  return summary;
}

/** Bounded owner batches preserve disclosure for referenced values without a
 * graph/Access request per qualifier. A reference is not an explicit Context
 * read: an absent context:read scope withholds that reference. */
export async function visibleResourceReferences(
  session: WorkReadSession,
  references: readonly string[],
) {
  const resources = [...new Set(references)];
  const visible = new Set<string>();
  const reader = targetSummaryReader(session);
  const privateContext = reader.canReadPrivateContext;
  const privateContexts = reader.canReadPrivateContexts;
  for (let start = 0; start < resources.length; start += MAX_SUMMARY_BATCH) {
    const batch = await readResourceSummaries(
      session.deps.environment,
      session.deps.media?.store,
      {
        ...reader,
        canReadPrivateContext: privateContext
          ? async (context) => {
              try {
                return await privateContext(context);
              } catch (error) {
                if (error instanceof AccountAssertionDenied) return false;
                throw error;
              }
            }
          : undefined,
        canReadPrivateContexts: privateContexts
          ? async (contexts) => {
              try {
                return await privateContexts(contexts);
              } catch (error) {
                if (error instanceof AccountAssertionDenied) return new Set<string>();
                throw error;
              }
            }
          : undefined,
      },
      {
        resources: resources.slice(start, start + MAX_SUMMARY_BATCH),
        context: DEFAULT_MEDIA_CONTEXT,
        language: session.options.language ?? null,
        languages: session.displayLanguages,
      },
    );
    if (batch.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
      throw new WorkReadMoved('Graph changed during reference hydration');
    }
    for (const summary of batch.summaries)
      if (summary.status === 'available') visible.add(summary.reference);
  }
  return visible;
}
