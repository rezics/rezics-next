import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { ReadingBoundary } from '../reading-position/boundary.ts';
import { decodeReadCursor, encodeReadCursor } from '../work/read-session.ts';

type PageRequest = Parameters<typeof readCompositionPage>[1];
type BatchReader = NonNullable<PageRequest['canReadTargets']>;
type Request = Omit<PageRequest, 'canReadTarget' | 'canReadTargets'> & (
  { canReadTargets: BatchReader; canReadTarget?: PageRequest['canReadTarget'] }
  | { canReadTargets?: BatchReader; canReadTarget: PageRequest['canReadTarget'] });
type Occurrence = Awaited<ReturnType<typeof readCompositionPage>>['occurrences'][number];

/** Filter within the immutable range scan: neither sparse visible pages nor
 * lookahead has an inventory ceiling. Only a later disclosed occurrence creates
 * a continuation. A trailing private member reveals no cursor or count.
 * The shared scan deduplicates candidate targets, including lookahead, before
 * calling canReadTargets. Scalar callers are retained only until the remaining
 * Zone and wiki owner changes land. */
export async function readVisibleCompositionPage(env: WorkActivationEnvironment,
  input: Request & { limit: number; visible: (item: Occurrence) => boolean; readingBoundary?: ReadingBoundary }) {
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(VISIBLE_PAGE_COST.deadlineMs);
  const canReadTargets = input.canReadTargets ?? (async (targets: readonly string[]) => {
    const readable = new Set<string>();
    for (const target of new Set(targets)) if (await input.canReadTarget!(target)) readable.add(target);
    return readable;
  });
  const canReadTarget = async (target: string) => (await canReadTargets([target])).has(target);
  if (!input.readingBoundary) return readCompositionPage(env, { ...input, canReadTargets, canReadTarget, signal });
  const boundary = input.readingBoundary;
  const binding = ['reading-position-members-v1', input.structure, input.revision, input.parent,
    boundary.session.principal, boundary.session.options.actingSubject, await boundary.binding()];
  const cursor = decodeReadCursor(input.after, binding, boundary.session.position);
  const page = await readCompositionPage(env, { ...input, after: cursor?.after, signal, canReadTarget,
    canReadTargets: async targets => {
      const readable = await canReadTargets(targets);
      const visible = await boundary.visible([...readable]);
      return new Set([...readable].filter(target => visible.has(target)));
    } });
  await boundary.fence();
  return { ...page, next: page.next ? encodeReadCursor(binding, boundary.session.position, page.next) : null };
}

export const VISIBLE_PAGE_COST = { deadlineMs: 5_000, immutableRangeRows: 101,
  targetChecksPerPlacement: 1, targetBatchesPerRange: 2 } as const;
