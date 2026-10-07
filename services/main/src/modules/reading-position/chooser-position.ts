import { readCompositionHeader } from '../structure/graph.ts';
import { disclosedCompletedProgress } from '../progress/disclosure.ts';
import { ProgressOrderUnavailable, type ResumePageKey } from '../progress/store.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { ReadingResumeContinuation, ReadingResumeUnavailable } from './errors.ts';
import type { ReadingPositionTraversal } from './traversal.ts';

/** Resume is one indexed owner range, with a fixed disclosure fallback window.
 * Sessions, Library status and full-history hashes cannot establish this order. */
export async function chooserPosition(session: WorkReadSession, traversal: ReadingPositionTraversal,
  selection: string, ownReader: boolean,
  disclose: typeof disclosedCompletedProgress = disclosedCompletedProgress, after?: ResumePageKey): Promise<string> {
  if (selection === 'all') return 'all';
  if (selection === 'start' || selection === 'mine' && !ownReader) return 'start';
  if (selection !== 'mine') {
    const location = await traversal.location(selection);
    if (!location) return 'start';
    await traversal.requireLocation(location);
    return location.item.occurrence;
  }
  const { principal, options, deps } = session;
  if (!principal || !options.actingSubject) return 'start';
  if (!deps.progress) throw new ReadingResumeUnavailable('The resume order index is unavailable');
  await traversal.requireWork(traversal.root);
  const meta = await traversal.metadataFor(traversal.root);
  if (!meta.structure) return 'start';
  const header = await readCompositionHeader(deps.environment, meta.structure);
  if (!header || header.head !== meta.revision) throw new ReadingResumeUnavailable('Resume order changed');
  let candidates;
  try { candidates = await deps.progress.resumeCandidates(principal, meta.structure, header.head, after); }
  catch (error) {
    if (error instanceof ProgressOrderUnavailable) throw new ReadingResumeUnavailable('Saved progress is being prepared for resume. Try again shortly.');
    throw error;
  }
  const visible = await disclose(session, header, candidates.items);
  for (const row of visible) {
    const location = await traversal.location(row.occurrence);
    if (!location) continue;
    try {
      await traversal.requireLocation(location);
      // Only the selected candidate's target can require a nested index.
      // A keyed metadata lookup never joins the terminal Episode inventory.
      if (location.item.role === 'part' && location.item.target
        && (await traversal.metadataFor(location.item.target)).structure) {
        throw new ReadingResumeUnavailable('A continuity-wide resume order index is unavailable');
      }
      return row.occurrence;
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
    }
  }
  if (candidates.more && candidates.next) throw new ReadingResumeContinuation(candidates.next);
  return 'start';
}
