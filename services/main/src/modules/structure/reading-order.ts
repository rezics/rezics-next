import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { OccurrenceRecord } from './format.ts';
import { CompositionCorrupt, CompositionUnavailable, orderTreeKey, readCompositionHeader,
  type CompositionHeader } from './graph.ts';
import { orderTree } from './change.ts';
import { readCompositionPage, readCompositionSnapshot, type CompositionPage, type CompositionSnapshot } from './read.ts';
import { WorkReadLimit } from '../work/read-session.ts';

/** Each step seeks one sibling or climbs one parent at a selected immutable root.
 * Exhaustion is an explicit limit, never an apparent end of the Book. */
export const READING_ORDER_COST = { steps: 256 } as const;

type Placed = Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey' | 'occurrence'>>;

/** Depth-first reading order in either direction. Denied candidates retain their
 * immutable anchors; no visible-page refill can walk an entire hidden prefix. */
export async function seekChapter(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; header?: CompositionHeader; snapshot?: CompositionSnapshot;
  from?: OccurrenceRecord; direction?: 'previous' | 'next'; maxSteps?: number;
  canReadTarget: (target: string) => Promise<boolean>;
  accept?: (record: OccurrenceRecord) => Promise<boolean>;
  checkDeadline?: () => void;
}): Promise<{ record: OccurrenceRecord; page: CompositionPage } | null> {
  const header = input.header ?? input.snapshot?.header ?? await readCompositionHeader(env, input.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  const snapshot = input.snapshot ?? await readCompositionSnapshot(env, {
    structure: input.structure, header, revision: input.revision ?? header.head });
  const revision = input.revision ?? snapshot.revision;
  const reverse = input.direction === 'previous';
  const read = (selector: { parent: string; after?: string } | { occurrence: string }) =>
    readCompositionPage(env, { structure: input.structure, header, snapshot, revision,
      ...selector, reverse, limit: 1, canReadTarget: input.canReadTarget });
  const placed = (record: OccurrenceRecord | undefined): Placed => {
    if (!record || record.state !== 'active' || !record.segmentKey || !record.orderKey) {
      throw new CompositionCorrupt('reading position is not an active placement');
    }
    return record as Placed;
  };
  const maximum = input.maxSteps ?? READING_ORDER_COST.steps;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > READING_ORDER_COST.steps) {
    throw new WorkReadLimit('Reading neighbourhood exceeds its step budget');
  }
  let parent = input.structure;
  let after: string | undefined;
  if (input.from) {
    const from = placed(input.from);
    const key = orderTreeKey(from);
    const selected = (await orderTree(snapshot.objects).lookup(snapshot.manifest.order, [key], snapshot.cost)).get(key);
    if (selected?.occurrence !== from.occurrence) throw new CompositionCorrupt('reading position differs from selected revision');
    parent = from.parent;
    after = key;
  }
  const entered = new Map<string, OccurrenceRecord>();
  let steps = 0;
  const step = () => {
    input.checkDeadline?.();
    if (++steps > maximum) throw new WorkReadLimit('Reading neighbourhood exceeds its step budget');
  };
  for (;;) {
    step();
    const page = await read({ parent, ...(after ? { after } : {}) });
    const item = page.occurrences[0];
    if (item?.role === 'chapter') {
      const anchor = placed(item);
      if (item.target && (!input.accept || await input.accept(item))) return { record: item, page };
      after = orderTreeKey(anchor);
      continue;
    }
    if (item?.role === 'group') {
      entered.set(item.occurrence, item);
      parent = item.occurrence;
      after = undefined;
      continue;
    }
    if (item) throw new CompositionCorrupt('a Book holds only groups and chapters');
    if (parent === input.structure) return null;
    let group = entered.get(parent);
    if (!group) {
      step();
      group = (await read({ occurrence: parent })).occurrences[0];
    }
    const anchor = placed(group);
    if (group?.role !== 'group') throw new CompositionCorrupt('reading parent is not a group');
    after = orderTreeKey(anchor);
    parent = anchor.parent;
  }
}

/** The first readable chapter after an exact placement, or the Book's first. */
export function nextChapter(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; from?: OccurrenceRecord;
  canReadTarget: (target: string) => Promise<boolean>;
}) {
  return seekChapter(env, input);
}
