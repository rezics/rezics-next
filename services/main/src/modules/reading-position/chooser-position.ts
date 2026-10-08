import { readCompositionHeader } from '../structure/graph.ts';
import { disclosedCompletedProgress } from '../progress/disclosure.ts';
import { ProgressOrderUnavailable, type ResumePageKey } from '../progress/store.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { continuityKey, CONTINUITY_MEMBER_BOUND } from './continuity.ts';
import { ReadingContinuityUnsupported, ReadingResumeContinuation, ReadingResumeUnavailable } from './errors.ts';
import type { ReadingWork, ReadingPositionTraversal } from './traversal.ts';

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
  if (!deps.progress) throw new ReadingResumeUnavailable('The resume order index is unavailable');
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
