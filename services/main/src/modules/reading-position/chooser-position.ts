import { GRAPHS, iri } from '../work/activate.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { disclosedCompletedProgress } from '../progress/disclosure.ts';
import { ProgressOrderUnavailable, type ResumePageKey } from '../progress/store.ts';
import { parseStoredRelease } from '../release/schema.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { continuityKey, CONTINUITY_MEMBER_BOUND } from './continuity.ts';
import { READING_POSITION_COST } from './contract.ts';
import { ReadingContinuityUnsupported, ReadingResumeContinuation, ReadingResumeUnavailable } from './errors.ts';
import { compareReadingLocations, READING_CHOOSER_COST, type ReadingLocation, type ReadingWork, type ReadingPositionTraversal } from './traversal.ts';

/** Resume is one indexed owner range, with a fixed disclosure fallback window.
 * A chapter inside a volume is that volume's place in the series index plus
 * the chapter's place in the volume. Sessions, Library status and full-history
 * hashes cannot establish this order. */
export async function chooserPosition(session: WorkReadSession, traversal: ReadingPositionTraversal,
  selection: string, ownReader: boolean,
  disclose: typeof disclosedCompletedProgress = disclosedCompletedProgress, after?: ResumePageKey): Promise<string> {
  if (selection === 'all') return 'all';
  if (selection === 'start' || selection === 'mine' && !ownReader) return 'start';
  if (selection !== 'mine') {
    const location = await traversal.location(selection);
    if (!location) return 'start';
    continuityKey(location);
    await traversal.requireLocation(location);
    return location.item.occurrence;
  }
  const { principal, options, deps } = session;
  if (!principal || !options.actingSubject) return 'start';
  // An empty progress slot means this read has a resume index whose owner is
  // down. Paging sessions or completion history would walk the series, so the
  // read fails before either source is touched. A session that was never given
  // the slot still resumes from its saved pins.
  if ('progress' in deps && !deps.progress) throw new ReadingResumeUnavailable('The resume order index is unavailable');
  if (!deps.progress) return readerStatePosition(session, traversal);
  await traversal.requireWork(traversal.root);
  const meta = await traversal.metadataFor(traversal.root);
  if (!meta.structure) return 'start';
  if (after?.structure && after.structure !== meta.structure) {
    const header = await readCompositionHeader(deps.environment, after.structure);
    if (!header) throw new ReadingResumeUnavailable('Resume order changed');
    const inner = await resumeMember(session, traversal, disclose, {
      work: header.work, structure: header.structure, revision: header.head, generation: header.generation,
    }, 1, after, after.seriesOccurrence);
    if (inner) return inner;
    after = after.seriesOccurrence ? { occurrence: after.seriesOccurrence, selectedRevision: null } : undefined;
  }
  const header = await readCompositionHeader(deps.environment, meta.structure);
  if (!header || header.head !== meta.revision) throw new ReadingResumeUnavailable('Resume order changed');
  let candidates;
  try { candidates = await deps.progress.resumeCandidates(principal, meta.structure, header.head, seriesAfter(after)); }
  catch (error) {
    if (error instanceof ProgressOrderUnavailable) throw new ReadingResumeUnavailable('Saved progress is being prepared for resume. Try again shortly.');
    throw error;
  }
  const visible = await disclose(session, header, candidates.items);
  const visibleIds = new Set(visible.map(row => row.occurrence));
  const placed = visible.length < candidates.items.length
    ? new Map((await traversal.recordsFor(candidates.items.map(row => row.occurrence))).map(item => [item.occurrence, item]))
    : new Map();
  for (const row of candidates.items) {
    const anchor = placed.get(row.occurrence);
    if (!visibleIds.has(row.occurrence) && (!anchor || anchor.structure === meta.structure)) continue;
    const location = await traversal.location(row.occurrence);
    if (!location) continue;
    continuityKey(location);
    try {
      await traversal.requireLocation(location);
      if (location.item.role === 'part' && location.item.target) {
        const child = await traversal.metadataFor(location.item.target);
        if (child.structure) {
          const inner = await resumeMember(session, traversal, disclose, child, 1, undefined, row.occurrence);
          if (inner) return inner;
        }
      }
      return row.occurrence;
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
    }
  }
  if (candidates.more && candidates.next) throw new ReadingResumeContinuation(candidates.next);
  return 'start';
}

function seriesAfter(after?: ResumePageKey): ResumePageKey | undefined {
  if (!after || after.structure) return undefined;
  return { occurrence: after.occurrence, selectedRevision: after.selectedRevision };
}

/** The member's own resume index, one Structure. A further composed Work is
 * the supported-bound refusal, not an empty completion. */
async function resumeMember(session: WorkReadSession, traversal: ReadingPositionTraversal,
  disclose: typeof disclosedCompletedProgress, child: ReadingWork, depth: number,
  after: ResumePageKey | undefined, seriesMember: string | undefined): Promise<string | null> {
  if (depth > CONTINUITY_MEMBER_BOUND) {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  }
  const { principal, deps } = session;
  if (!child.structure || !child.revision || !deps.progress || !principal) {
    throw new ReadingContinuityUnsupported('A reading position is nested deeper than this continuity can resolve');
  }
  const header = await readCompositionHeader(deps.environment, child.structure);
  if (!header || header.head !== child.revision) throw new ReadingResumeUnavailable('Resume order changed');
  let candidates;
  try {
    candidates = await deps.progress.resumeCandidates(principal, child.structure, header.head, after && {
      occurrence: after.occurrence, selectedRevision: after.selectedRevision,
    });
  } catch (error) {
    if (error instanceof ProgressOrderUnavailable) throw new ReadingResumeUnavailable('Saved progress is being prepared for resume. Try again shortly.');
    throw error;
  }
  const visible = await disclose(session, header, candidates.items);
  for (const row of visible) {
    const location = await traversal.location(row.occurrence);
    if (!location) continue;
    continuityKey(location);
    try {
      await traversal.requireLocation(location);
      if (location.item.role === 'part' && location.item.target) {
        const nested = await traversal.metadataFor(location.item.target);
        if (nested.structure) return resumeMember(session, traversal, disclose, nested, depth + 1, undefined, seriesMember);
      }
      return row.occurrence;
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
    }
  }
  if (candidates.more && candidates.next) {
    throw new ReadingResumeContinuation({ ...candidates.next, structure: child.structure, seriesOccurrence: seriesMember });
  }
  return null;
}

/** Furthest saved place when no prepared resume index exists. Sessions, a
 * completed page and finished Works name occurrences; their order is the same
 * continuity key as the index. This does not walk chapter inventory. */
async function readerStatePosition(session: WorkReadSession, traversal: ReadingPositionTraversal): Promise<string> {
  const { principal, options, deps } = session;
  if (!principal || !options.actingSubject) return 'start';
  let furthest: ReadingLocation | null = null;
  const consider = (location: ReadingLocation | null) => {
    if (location && (!furthest || compareReadingLocations(location, furthest) > 0)) furthest = location;
  };
  const finishes = new Map<string, Promise<ReadingLocation | null>>();
  const finish = (work: string) => {
    if (!finishes.has(work)) finishes.set(work, traversal.last(work));
    return finishes.get(work)!;
  };
  const releases = new Map<string, { resource: string; revision: string }>();
  for await (const batch of traversal.works()) {
    const works = batch.map(meta => meta.work), structures = batch.flatMap(meta => meta.structure ? [meta.structure] : []);
    if (deps.readingPositions && structures.length) {
      let after: string | undefined;
      do {
        const progress = await deps.readingPositions.completedPage(principal, structures, after);
        await traversal.recordsFor(progress.items);
        for (const occurrence of progress.items) consider(await traversal.location(occurrence));
        after = progress.next ?? undefined;
      } while (after);
    }
    if (deps.seriesSessions) {
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= READING_POSITION_COST.sessionPages) throw new WorkReadUnavailable('Reader history exceeds its cost');
        const attempts = await deps.seriesSessions.batch({ principal, agent: options.actingSubject }, works, [], session.position, cursor);
        for (const attempt of attempts.items) if (attempt.state === 'finished') {
          const occurrences = attempt.selections.flatMap(selected => selected.target.base === 'occurrence' ? [selected.target] : []);
          for (let at = 0; at < occurrences.length; at += READING_CHOOSER_COST.workBatch) {
            const pins = occurrences.slice(at, at + READING_CHOOSER_COST.workBatch);
            await traversal.recordsFor(pins.map(pin => pin.resource));
            for (const pin of pins) {
              const location = await traversal.location(pin.resource);
              if (location?.item.revision === pin.revision) consider(location);
            }
          }
          for (const selected of attempt.selections) {
            const target = selected.target;
            if (target.base === 'work') consider(await finish(target.resource));
            else if (target.base === 'realization' && target.work) consider(await finish(target.work));
            else if (target.base === 'release' && target.revision) {
              releases.set(`${target.resource}|${target.revision}`, { resource: target.resource, revision: target.revision });
            }
          }
        }
        if (!attempts.next) break;
        cursor = attempts.next;
      }
    }
    if (deps.readingPositions) {
      for (const work of await deps.readingPositions.finishedWorks(options.actingSubject, works)) consider(await finish(work));
    }
  }
  if (releases.size > READING_POSITION_COST.releasePins) throw new WorkReadUnavailable('Reader release pins exceed their cost');
  const releasePins = [...releases.values()];
  for (let at = 0; at < releasePins.length; at += READING_CHOOSER_COST.workBatch) {
    const batch = releasePins.slice(at, at + READING_CHOOSER_COST.workBatch);
    const rows = await session.query(`SELECT ?resource ?revision ?state WHERE {
      VALUES (?resource ?revision) { ${batch.map(pin => `(${iri(pin.resource)} ${iri(pin.revision)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ?resource ; rv:releaseState ?state }
    } LIMIT ${batch.length + 1}`, batch.length);
    if (rows.length !== batch.length) throw new WorkReadUnavailable('Pinned release coverage is unavailable');
    for (const row of rows) {
      const release = parseStoredRelease(row.state!.value);
      if (release.id !== row.resource?.value) throw new WorkReadUnavailable('Pinned release identity differs');
      if (release.profile === 'release-v2') for (const entry of release.coverage) {
        if (entry.completeness === 'complete') {
          const covered = release.resolvedCoverage.find(pin => pin.realization === entry.realization);
          if (covered) consider(await finish(covered.work));
        }
      }
    }
  }
  const selected = furthest as ReadingLocation | null;
  if (!selected) return 'start';
  await traversal.requireLocation(selected);
  return selected.item.occurrence;
}
