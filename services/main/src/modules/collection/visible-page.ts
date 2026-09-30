import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

type Request = Parameters<typeof readCompositionPage>[1];
type Occurrence = Awaited<ReturnType<typeof readCompositionPage>>['occurrences'][number];

/** Filter within the immutable range scan: neither sparse visible pages nor
 * lookahead has an inventory ceiling. Only a later disclosed occurrence creates
 * a continuation. A trailing private member reveals no cursor or count. */
export async function readVisibleCompositionPage(env: WorkActivationEnvironment,
  input: Request & { limit: number; visible: (item: Occurrence) => boolean }) {
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(VISIBLE_PAGE_COST.deadlineMs);
  return readCompositionPage(env, { ...input, signal });
}

export const VISIBLE_PAGE_COST = { deadlineMs: 5_000, immutableRangeRows: 101,
  targetChecksPerPlacement: 1 } as const;
