import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { ReadingBoundary } from '../reading-position/boundary.ts';
import { decodeReadCursor, encodeReadCursor, type WorkReadSession } from '../work/read-session.ts';
import { admittedReadPosition } from '../read-basis/admitted-position.ts';

type PageRequest = Parameters<typeof readCompositionPage>[1];
type BatchReader = NonNullable<PageRequest['canReadTargets']>;
type Request = Omit<PageRequest, 'canReadTarget' | 'canReadTargets'> & { canReadTargets: BatchReader;
  canReadTargetsForSession?: (session: WorkReadSession) => BatchReader };
type Occurrence = Awaited<ReturnType<typeof readCompositionPage>>['occurrences'][number];

/** Filter within the immutable range scan: neither sparse visible pages nor
 * lookahead has an inventory ceiling. Only a later disclosed occurrence creates
 * a continuation. A trailing private member reveals no cursor or count.
 * The shared scan deduplicates candidate targets, including lookahead, before
 * calling canReadTargets. An exact occurrence uses a one-target batch. */
export async function readVisibleCompositionPage(env: WorkActivationEnvironment,
  input: Request & { limit: number; visible: (item: Occurrence) => boolean; readingBoundary?: ReadingBoundary }) {
  const signal = fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(VISIBLE_PAGE_COST.deadlineMs);
  const boundary = input.readingBoundary;
  const canReadTargets: BatchReader = async targets => {
    signal.throwIfAborted();
    const readable = await input.canReadTargets(targets);
    signal.throwIfAborted();
    if (!boundary) return readable;
    const visible = await boundary.visible([...readable]);
    return new Set([...readable].filter(target => visible.has(target)));
  };
  const canReadTarget = async (target: string) => (await canReadTargets([target])).has(target);
  if (!boundary) return readCompositionPage(env, { ...input, canReadTargets, canReadTarget, signal });
  const binding = ['reading-position-members-v1', input.structure, input.revision, input.parent,
    boundary.session.cursorIdentity, boundary.session.options.actingSubject, boundary.selection];
  const select = async (probe: WorkReadSession, limit: number, after?: string) => {
    const selectedBoundary = new ReadingBoundary(probe, boundary.selection);
    const readTargets = input.canReadTargetsForSession?.(probe) ?? input.canReadTargets;
    const selectedTargets: BatchReader = async targets => selectedBoundary.visible([...(await readTargets(targets))]);
    const page = await readCompositionPage(env, { ...input, limit, after, signal,
      canReadTargets: selectedTargets, canReadTarget: async target => (await selectedTargets([target])).has(target) });
    await selectedBoundary.fence();
    return page;
  };
  const position = await admittedReadPosition(boundary.session, JSON.stringify(binding), async function* (probe) {
    let after: string | undefined;
    do {
      const page = await select(probe, 100, after);
      if (!after) yield [page.structure, page.revision];
      yield page.occurrences;
      after = page.next ?? undefined;
    } while (after);
  });
  const cursor = decodeReadCursor(input.after, binding, position);
  const page = await boundary.session.selection(`collection-page:${JSON.stringify([binding, cursor?.after, input.limit])}`,
    probe => select(probe, input.limit, cursor?.after), page => ({ revision: page.revision, occurrences: page.occurrences,
      more: !!page.next }));
  return { ...page, sourcePosition: { ...page.sourcePosition, ...position },
    next: page.next ? encodeReadCursor(binding, position, page.next) : null };
}

export const VISIBLE_PAGE_COST = { deadlineMs: 5_000, immutableRangeRows: 101,
  targetChecksPerPlacement: 1, targetBatchesPerRange: 2 } as const;
