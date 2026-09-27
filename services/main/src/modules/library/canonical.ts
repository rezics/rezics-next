import { canonicalChapterWorks } from '../structure/chapter-work.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import type { ReaderLibraryStatusStore, StatusState } from './status.ts';

export const CANONICAL_STATUS_COST = { candidates: 240, batch: 24,
  chapterQueries: 10, parentStatusQueries: 10 } as const;

/** Reconcile legacy chapter status rows for reads without changing their
 * stored idempotency/version history. A parent status always takes precedence. */
export async function canonicalStatusCandidates(session: WorkReadSession, agent: string,
  store: ReaderLibraryStatusStore): Promise<StatusState[]> {
  const candidates = await store.publicCandidates(agent);
  const parents = new Map<string, string>();
  for (let offset = 0; offset < candidates.length; offset += CANONICAL_STATUS_COST.batch) {
    const mapped = await canonicalChapterWorks(session,
      candidates.slice(offset, offset + CANONICAL_STATUS_COST.batch).map(row => row.work));
    for (const [child, parent] of mapped) parents.set(child, parent);
  }
  const parentIds = [...new Set(parents.values())];
  const parentStates = new Map<string, StatusState>();
  for (let offset = 0; offset < parentIds.length; offset += CANONICAL_STATUS_COST.batch) {
    for (const state of await store.batch(agent,
      parentIds.slice(offset, offset + CANONICAL_STATUS_COST.batch))) {
      parentStates.set(state.work, state);
    }
  }
  const canonical = new Map<string, StatusState>();
  for (const row of candidates) {
    const work = parents.get(row.work) ?? row.work;
    const parent = parentStates.get(work);
    if (work !== row.work && parent?.status) continue;
    const resolved = work === row.work ? row : { ...row, work, version: parent?.version ?? 0 };
    const prior = canonical.get(work);
    if (!prior || work === row.work || prior.changedAt && resolved.changedAt
      && resolved.changedAt > prior.changedAt) canonical.set(work, resolved);
  }
  return [...canonical.values()].sort((a, b) =>
    (b.changedAt ?? '').localeCompare(a.changedAt ?? '') || b.work.localeCompare(a.work));
}
