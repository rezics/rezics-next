import { readCompositionHeader } from '../structure/graph.ts';
import { disclosedCompletedProgress } from '../progress/disclosure.ts';
import { ProgressOrderUnavailable } from '../progress/store.ts';
import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { ReadingResumeDisclosureBound, ReadingResumeUnavailable } from './errors.ts';
import type { ReadingPositionTraversal } from './traversal.ts';

/** Resume is one indexed owner range, with a fixed disclosure fallback window.
 * Sessions, Library status and full-history hashes cannot establish this order. */
export async function chooserPosition(session: WorkReadSession, traversal: ReadingPositionTraversal,
  selection: string, ownReader: boolean,
  disclose: typeof disclosedCompletedProgress = disclosedCompletedProgress): Promise<string> {
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
  if (await traversal.hasNestedComposition(meta)) {
    throw new ReadingResumeUnavailable('A continuity-wide resume order index is unavailable');
  }
  const header = await readCompositionHeader(deps.environment, meta.structure);
  if (!header || header.head !== meta.revision) throw new ReadingResumeUnavailable('Resume order changed');
  let candidates;
  try { candidates = await deps.progress.resumeCandidates(principal, meta.structure, header.head); }
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
      return row.occurrence;
    } catch (error) {
      if (!(error instanceof WorkReadMissing)) throw error;
    }
  }
  if (candidates.more) throw new ReadingResumeDisclosureBound('No readable completion was found within the 16-candidate resume bound');
  return 'start';
}
