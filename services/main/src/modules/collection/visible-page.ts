import { CompositionCorrupt } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

type Request = Parameters<typeof readCompositionPage>[1];
type Occurrence = Awaited<ReturnType<typeof readCompositionPage>>['occurrences'][number];

/** A bounded scan suppresses hidden placements and emits a cursor only after
 * proving that a later visible occurrence exists. A private trailing member
 * cannot reveal itself through `next`, count or variable public cost fields. */
export async function readVisibleCompositionPage(env: WorkActivationEnvironment,
  input: Request & { limit: number; visible: (item: Occurrence) => boolean }) {
  const { visible, limit, ...base } = input;
  const maxPages = 8;
  let cursor = base.after;
  let head: Awaited<ReturnType<typeof readCompositionPage>> | undefined;
  const occurrences: Occurrence[] = [];
  let pages = 0;
  while (occurrences.length < limit) {
    if (++pages > maxPages) throw new CompositionCorrupt('visible page exceeds its scan budget');
    const page = await readCompositionPage(env, { ...base, ...(cursor ? { after: cursor } : {}),
      limit: limit - occurrences.length });
    head ??= page;
    if (page.revision !== head.revision) throw new CompositionCorrupt('visible page snapshot moved');
    occurrences.push(...page.occurrences.filter(visible));
    if (!page.next) return { ...head, occurrences, next: null,
      cost: { pagesScanned: pages, maxPages } };
    if (page.next === cursor) throw new CompositionCorrupt('visible page cursor did not advance');
    cursor = page.next;
  }
  // `next` means another *visible* occurrence exists, not merely another private placement.
  let probe = cursor;
  while (probe) {
    if (++pages > maxPages) throw new CompositionCorrupt('visible lookahead exceeds its scan budget');
    const page = await readCompositionPage(env, { ...base, after: probe, limit: 100 });
    if (page.revision !== head!.revision) throw new CompositionCorrupt('visible page snapshot moved');
    if (page.occurrences.some(visible)) return { ...head!, occurrences, next: cursor,
      cost: { pagesScanned: pages, maxPages } };
    if (page.next === probe) throw new CompositionCorrupt('visible lookahead cursor did not advance');
    probe = page.next ?? undefined;
  }
  return { ...head!, occurrences, next: null, cost: { pagesScanned: pages, maxPages } };
}

export const VISIBLE_PAGE_COST = { maxPages: 8, maxLookaheadLimit: 100,
  targetChecksPerPlacement: 1 } as const;
