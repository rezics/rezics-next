import type { Static } from 'typebox';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { MAX_SUMMARY_BATCH, readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { capabilityBases, type Base, type ResolvedTarget } from '../target/contract.ts';
import { resolveTargets, targetSummaryReader } from '../target/resolve.ts';
import { admittedTypes } from '../types/registry.ts';
import { readWorkHeader } from '../work/read-header.ts';
import { readWorkRating } from '../work/read-rating.ts';
import {
  decodeReadCursor, encodeReadCursor, WorkReadMissing,
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { entitySection, type SectionId } from './contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { readFrames } from '../projection/frame-read.ts';
import { readSubjectStatements } from '../statement/subject-read.ts';
import { readPageRelations } from './relations.ts';

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
  ],
  release: ['statements', 'relations', 'credits', 'ratings', 'reviews', 'discussion'],
  realization: ['statements', 'relations', 'discussion'],
  occurrence: ['statements', 'relations', 'discussion'],
  resource: ['statements', 'relations', 'discussion'],
  projection: ['statements', 'relations', 'ratings', 'reviews', 'discussion'],
} as const satisfies Record<Base, readonly SectionId[]>;

export function pageRegistry(target: Pick<ResolvedTarget, 'base' | 'types'>) {
  const registryBase =
    target.base === 'work' || target.base === 'resource' || target.base === 'projection'
      ? target.base
      : 'record';
  const entries = admittedTypes.filter(
    (entry) => entry.base === registryBase && !entry.default && target.types.includes(entry.type),
  );
  const selected =
    entries.sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type))[0] ??
    admittedTypes.find((entry) => entry.base === registryBase && entry.default);
  if (!selected) throw new WorkReadUnavailable('Target base has no registry default');
  return selected;
}

export function pageSections(
  target: ResolvedTarget,
  mountedReads: ReadonlySet<string>,
): Static<typeof entitySection>[] {
  const registry = pageRegistry(target);
  const typeSection =
    target.base === 'work' && ['recipe', 'prompt', 'skill'].includes(registry.presentation)
      ? (registry.presentation as 'recipe' | 'prompt' | 'skill')
      : null;
  // Prefer a generic owner read when mounted; legacy Work reads remain valid
  // only for a Work. Pending owner inventories do not advertise dead links.
  const sections: Static<typeof entitySection>[] = baseSections[target.base].flatMap((id) => {
    const paths = [
      `/v1/resources/:resource/${id}`,
      ...(target.base === 'work' ? [`/v1/works/:id/${id}`] : []),
    ];
    const path = paths.find((candidate) => mountedReads.has(candidate));
    return path
      ? [{ id, href: path.replace(/:(?:resource|id)\b/, target.resource.slice(-36)), actions: [] }]
      : [];
  });
  const typePath = `/v1/${typeSection === 'recipe' ? 'recipes' : 'hub'}/works/:id`;
  if (typeSection && mountedReads.has(typePath))
    sections.splice(1, 0, {
      id: typeSection,
      href: typePath.replace(':id', target.resource.slice(-36)),
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

export async function readEntityPage(
  session: WorkReadSession,
  resource: string,
  mountedReads: ReadonlySet<string>,
) {
  const target = (await resolveTargets(session, [resource], 'discussion'))[0]!;
  const boundary = readingBoundary(session);
  await boundary.require(target.resource);
  // Resolve again after hydration: graph-position fences alone do not detect an
  // Access revocation. Use G-506's reader, including semantic/Context grants.
  const summaryBatch = await resolveSummary(session, target.resource);
  const registry = pageRegistry(target);
  const sections = pageSections(target, mountedReads);
  const work = target.base === 'work' ? await readWorkHeader(session, target.resource) : null;
  let projection;
  if (target.base === 'projection') {
    const parts = summaryBatch.status === 'available' ? summaryBatch.parts : undefined;
    if (!parts) throw new WorkReadUnavailable('Projection parts are unavailable');
    const frames = await readFrames(session, parts.frames.map(frame => frame.reference));
    const statements = await readSubjectStatements(session, parts.subject.reference, undefined, frames);
    const relations = await readPageRelations(session, parts.subject.reference, frames);
    projection = { subject: parts.subject, frames: parts.frames, statements, relations };
    const selectedPosition = new URL(session.request.url).searchParams.get('position');
    for (const section of sections) if (['statements','relations'].includes(section.id)) {
      const query = new URLSearchParams();
      for (const frame of frames) query.append('frame', frame.iri);
      if (selectedPosition) query.set('position', selectedPosition);
      if (session.options.actingSubject) query.set('actingSubject', session.options.actingSubject);
      section.href = `/v1/resources/${parts.subject.reference.slice(-36)}/${section.id}?${query}`;
    }
    // Judgment sections keep the projection target and the mounted owner reads,
    // just as other resource pages do. Their context selection, pagination and
    // budgets belong to those reads; subject frames scope only facts/relations.
  }
  if (
    work?.disclosure === 'public' &&
    session.deps.access.readRatingAggregateInventory &&
    session.deps.access.checkRatingAggregateFence
  ) {
    try {
      const rating = await readWorkRating(session, resource);
      const section = sections.find((section) => section.id === 'ratings');
      if (section && rating.status === 'available' && rating.context) {
        section.count = {
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
        await session.deps.access.canEditWork(principal, session.options.actingSubject, target.resource)
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
  const mergedFacts = target.base === 'work' ? await readMergedFacts(session,target,mountedReads) : undefined;
  await resolveTargets(session, [target.resource], 'discussion');
  await boundary.fence();
  return {
    profile: 'entity-page-v1' as const,
    target,
    summary: summaryBatch,
    registry,
    work,
    sections,
    ...(mergedFacts ? { mergedFacts } : {}),
    ...(projection ? { projection } : {}),
    sourcePosition: session.position,
  };
}

export async function resolveSummary(session: WorkReadSession, resource: string) {
  // A target-only resolve intentionally returns no presentation metadata. Reuse
  // the same summary owner with semantic authority rather than Work-only summaries.
  const result = await readResourceSummaries(
    session.deps.environment,
    session.deps.media?.store,
    { ...targetSummaryReader(session), visibleRecords: records => readingBoundary(session).visible(records) },
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
        visibleRecords: records => readingBoundary(session).visible(records),
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

/** Retained facts keep their subjects, revisions and owners. A bounded page
 * includes each disclosed original header and its native fact inventories;
 * source links never transfer grants or creator rights to the survivor. */
async function readMergedFacts(session: WorkReadSession,target: ResolvedTarget,mountedReads: ReadonlySet<string>) {
  const binding = { owner: 'merged-facts-v1',target: target.resource },limit = session.options.limit ?? 4;
  const cursor = decodeReadCursor(session.options.cursor,binding,session.position);
  const rows = await session.query(`SELECT DISTINCT ?origin WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?origin rv:mergedInto+ ${iri(target.resource)} ; a schema:CreativeWork .
    ${cursor ? `FILTER(STR(?origin) > ${JSON.stringify(cursor.after)})` : ''}
  } } ORDER BY STR(?origin) LIMIT ${limit + 1}`,limit + 1);
  const sources = rows.slice(0,limit).map(row => row.origin!.value);
  const visible = await visibleResourceReferences(session,sources);
  const origins = [];
  for (const resource of sources) if (visible.has(resource)) {
    await readingBoundary(session).require(resource);
    const work = await readWorkHeader(session,resource);
    origins.push({ resource,work,sections: pageSections({ ...target,resource },mountedReads)
      .filter(section => !['ratings','reviews','discussion'].includes(section.id)) });
  }
  return { origins,nextCursor: rows.length > limit ? encodeReadCursor(binding,session.position,sources.at(-1)!) : null };
}
