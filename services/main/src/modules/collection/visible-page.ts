import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { ReadingBoundary } from '../reading-position/boundary.ts';
import { decodeReadCursor, encodeReadCursor } from '../work/read-session.ts';

type Request = Parameters<typeof readCompositionPage>[1];
type Occurrence = Awaited<ReturnType<typeof readCompositionPage>>['occurrences'][number];

/** Filter within the immutable range scan: neither sparse visible pages nor
 * lookahead has an inventory ceiling. Only a later disclosed occurrence creates
 * a continuation. A trailing private member reveals no cursor or count. */
export async function readVisibleCompositionPage(env: WorkActivationEnvironment,
  input: Request & { limit: number; visible: (item: Occurrence) => boolean; readingBoundary?: ReadingBoundary }) {
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(VISIBLE_PAGE_COST.deadlineMs);
  if (!input.readingBoundary) return readCompositionPage(env, { ...input, signal });
  const boundary = input.readingBoundary;
  const binding = ['reading-position-members-v1', input.structure, input.revision, input.parent,
    boundary.session.principal, boundary.session.options.actingSubject, await boundary.binding()];
  const cursor = decodeReadCursor(input.after, binding, boundary.session.position);
  const page = await readCompositionPage(env, { ...input, after: cursor?.after, signal,
    canReadTarget: async target => await input.canReadTarget(target) && (await boundary.visible([target])).has(target) });
  await boundary.fence();
  return { ...page, next: page.next ? encodeReadCursor(binding, boundary.session.position, page.next) : null };
}

export const VISIBLE_PAGE_COST = { deadlineMs: 5_000, immutableRangeRows: 101,
  targetChecksPerPlacement: 1 } as const;
