import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { OccurrenceRecord } from './format.ts';
import { CompositionCorrupt, CompositionUnavailable, orderTreeKey, readCompositionHeader } from './graph.ts';
import { readCompositionPage, type CompositionPage } from './read.ts';

/**
 * Exact page reads one walk may spend. Each step reads one level: the next
 * sibling, a group's first child, or the group a walk climbs out of. A Book
 * nests one group level, so crossing into the next volume takes three steps;
 * the rest skip empty groups before the walk gives up.
 */
export const READING_ORDER_COST = { steps: 8 } as const;

type Placed = Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey' | 'occurrence'>>;

/**
 * The first chapter after `from` in reading order, or the Book's first chapter
 * without `from`. Reading order is depth first: a group's chapters are read
 * where the group stands. Every step reads the revision the first step saw.
 * Returns null at the end of the Book, or when empty groups use up the steps.
 */
export async function nextChapter(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; from?: OccurrenceRecord;
  canReadTarget: (target: string) => Promise<boolean>;
}): Promise<{ record: OccurrenceRecord; page: CompositionPage } | null> {
  const header = await readCompositionHeader(env, input.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  // One header and one revision for the whole walk; each step then costs one revision query.
  const revision = input.revision ?? header.head;
  const read = (selector: { parent: string; after?: string } | { occurrence: string }) =>
    readCompositionPage(env, { structure: input.structure, header, revision, ...selector, limit: 1,
      canReadTarget: input.canReadTarget });
  const placed = (record: OccurrenceRecord | undefined): Placed => {
    if (!record || record.state !== 'active' || !record.segmentKey || !record.orderKey) {
      throw new CompositionCorrupt('reading position is not an active placement');
    }
    return record as Placed;
  };
  let parent = input.structure;
  let after: string | undefined;
  if (input.from) {
    const from = placed(input.from);
    parent = from.parent;
    after = orderTreeKey(from);
  }
  // Groups entered on this walk; climbing out of one needs no second read.
  const entered = new Map<string, OccurrenceRecord>();
  for (let step = 0; step < READING_ORDER_COST.steps; step++) {
    const page = await read({ parent, ...(after ? { after } : {}) });
    const item = page.occurrences[0];
    if (item?.role === 'chapter') return { record: item, page };
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
      step++;
      group = (await read({ occurrence: parent })).occurrences[0];
    }
    const placedGroup = placed(group);
    after = orderTreeKey(placedGroup);
    parent = placedGroup.parent;
  }
  return null;
}
