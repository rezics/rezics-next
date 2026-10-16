import type { WorkActivationEnvironment } from '../work/activate.ts';
import { STRUCTURE_LIMITS, type OccurrenceRecord } from './format.ts';
import { deepestLevel, isContainerRole, isReadingRole, structureProfileFor, type StructureProfileRegistration } from './profiles.ts';
import { CompositionCorrupt, CompositionUnavailable, orderTreeKey, readCompositionHeader,
  type CompositionHeader } from './graph.ts';
import { recordTree, orderTree } from './change.ts';
import { readCompositionPage, readCompositionSnapshot, type CompositionPage, type CompositionSnapshot } from './read.ts';
import { WorkReadLimit, WorkReadUnavailable } from '../work/read-session.ts';

/** Each step seeks one sibling or climbs one parent at a selected immutable root.
 * Exhaustion is an explicit limit, never an apparent end of the Book. */
export const READING_ORDER_COST = { steps: 256, targetChecks: 256 } as const;

type Placed = Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey' | 'occurrence'>>;

/** Depth-first reading order in either direction. Denied candidates retain their
 * immutable anchors; no visible-page refill can walk an entire hidden prefix. */
export async function seekOccurrence(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; header?: CompositionHeader; snapshot?: CompositionSnapshot;
  from?: OccurrenceRecord; direction?: 'previous' | 'next'; maxSteps?: number;
  canReadTarget: (target: string) => Promise<boolean>;
  accept?: (record: OccurrenceRecord) => Promise<boolean>;
  checkDeadline?: () => void;
}): Promise<{ record: OccurrenceRecord; page: CompositionPage } | null> {
  const header = input.header ?? input.snapshot?.header ?? await readCompositionHeader(env, input.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  const profile = structureProfileFor(header.profile);
  const snapshot = input.snapshot ?? await readCompositionSnapshot(env, {
    structure: input.structure, header, revision: input.revision ?? header.head });
  const revision = input.revision ?? snapshot.revision;
  const reverse = input.direction === 'previous';
  let targetChecks = 0;
  const read = (selector: { parent: string; after?: string } | { occurrence: string }) =>
    readCompositionPage(env, { structure: input.structure, header, snapshot, revision,
      ...('parent' in selector ? { parent: selector.parent, afterKey: selector.after } : selector),
      reverse, limit: 1, canReadTarget: async target => {
        input.checkDeadline?.();
        if (++targetChecks > READING_ORDER_COST.targetChecks) {
          throw new WorkReadLimit('Reading neighbourhood exceeds its target disclosure budget');
        }
        return input.canReadTarget(target);
      } });
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
  let depth = 1;
  if (input.from) {
    const from = placed(input.from);
    const key = orderTreeKey(from);
    const selected = (await orderTree(snapshot.objects).lookup(snapshot.manifest.order, [key], snapshot.cost)).get(key);
    if (selected?.occurrence !== from.occurrence) throw new CompositionCorrupt('reading position differs from selected revision');
    parent = from.parent;
    after = key;
    let ancestor = from.parent;
    const seen = new Set<string>();
    while (ancestor !== input.structure) {
      if (seen.has(ancestor) || ++depth > (profile.maxDepth ?? STRUCTURE_LIMITS.maxDepth)) {
        throw new CompositionCorrupt('reading ancestry exceeds its declared depth');
      }
      seen.add(ancestor);
      const owner = (await recordTree(snapshot.objects).lookup(snapshot.manifest.records, [ancestor], snapshot.cost)).get(ancestor);
      if (!owner || owner.state !== 'active' || !isContainerRole(profile, owner.role)) {
        throw new CompositionCorrupt('reading ancestry is not a declared container');
      }
      ancestor = owner.parent;
    }
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
    if (item && depth > deepestLevel(profile, item.role)) throw new CompositionCorrupt('reading occurrence exceeds its declared depth');
    if (item && !isContainerRole(profile, item.role)) {
      const anchor = placed(item);
      if (isReadingRole(profile, item.role)
        && (item.target !== undefined || !profile.targetRoles.includes(item.role))
        && (!input.accept || await input.accept(item))) return { record: item, page };
      after = orderTreeKey(anchor);
      continue;
    }
    if (item && isContainerRole(profile, item.role)) {
      depth++;
      entered.set(item.occurrence, item);
      parent = item.occurrence;
      after = undefined;
      continue;
    }
    if (parent === input.structure) return null;
    let group = entered.get(parent);
    if (!group) {
      step();
      group = (await read({ occurrence: parent })).occurrences[0];
    }
    const anchor = placed(group);
    if (!group || !isContainerRole(profile, group.role)) throw new CompositionCorrupt('reading parent is not a declared container');
    after = orderTreeKey(anchor);
    parent = anchor.parent;
    depth--;
  }
}

/** Compatibility entry point; navigation policy belongs to the selected profile. */
export const seekChapter = seekOccurrence;

/** The first readable chapter after an exact placement, or the Book's first. */
export function nextChapter(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; from?: OccurrenceRecord;
  canReadTarget: (target: string) => Promise<boolean>;
}) {
  return seekOccurrence(env, input);
}

/** A continuation holds immutable sibling anchors, never a buffered page tail. */
export interface StructureWalkFrame { parent: string; after?: string }
interface BufferedWalkFrame extends StructureWalkFrame {
  pending?: OccurrenceRecord[]; at?: number; more?: boolean;
}

/** Bounded depth-first pages shared by profile projections. Domain cursors and
 * calculations stay with the caller; this owner validates topology and order. */
export async function readHierarchyPage(input: {
  structure: string; profile: StructureProfileRegistration; stack: StructureWalkFrame[];
  limit: number; childReadLimit: number;
  readChildren(query: { parent: string; after?: string; limit: number }): Promise<{
    occurrences: OccurrenceRecord[]; next: string | null; pagesRead: number }>;
  readParent(occurrence: string): Promise<{ record: OccurrenceRecord | null; pagesRead: number }>;
}) {
  const stack: BufferedWalkFrame[] = input.stack;
  const maximum = input.profile.maxDepth ?? STRUCTURE_LIMITS.maxDepth;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > STRUCTURE_LIMITS.pageEntries
    || !Number.isInteger(input.childReadLimit) || input.childReadLimit < 1
    || input.childReadLimit > READING_ORDER_COST.steps) throw new WorkReadLimit('Hierarchy page exceeds its read bound');
  if (!stack.length || stack[0]!.parent !== input.structure || stack.length > maximum + 1
    || new Set(stack.map(frame => frame.parent)).size !== stack.length) {
    throw new WorkReadUnavailable('Hierarchy cursor ancestry differs from its profile');
  }
  let parentReads = 0, emptyReads = 0, dataReads = 0, pagesRead = 0;
  for (let index = 1; index < stack.length; index++) {
    const found = await input.readParent(stack[index]!.parent);
    parentReads++;
    pagesRead += found.pagesRead;
    const record = found.record;
    if (!record || record.state !== 'active' || !isContainerRole(input.profile, record.role)
      || index > deepestLevel(input.profile, record.role)
      || record.parent !== stack[index - 1]!.parent) {
      throw new WorkReadUnavailable('Hierarchy cursor parent is not in this revision');
    }
  }
  const taken: OccurrenceRecord[] = [];
  while (stack.length) {
    const frame = stack.at(-1)!;
    const consumed = frame.at ?? 0;
    if (!frame.pending || consumed >= frame.pending.length) {
      if (frame.pending && !frame.more) { stack.pop(); continue; }
      if (taken.length >= input.limit || emptyReads + dataReads >= input.childReadLimit) break;
      const page = await input.readChildren({ parent: frame.parent,
        ...(frame.after ? { after: frame.after } : {}), limit: input.limit });
      pagesRead += page.pagesRead;
      frame.pending = page.occurrences.slice(0, input.limit);
      frame.at = 0;
      frame.more = page.next != null || page.occurrences.length > input.limit;
      if (frame.pending.length) dataReads++; else emptyReads++;
      continue;
    }
    if (taken.length >= input.limit) break;
    const item = frame.pending[consumed]!;
    if (!input.profile.roles.includes(item.role) || !item.segmentKey || !item.orderKey
      || item.parent !== frame.parent || stack.length > deepestLevel(input.profile, item.role)) {
      throw new WorkReadUnavailable('Hierarchy occurrence differs from its declared topology');
    }
    frame.at = consumed + 1;
    taken.push(item);
    frame.after = orderTreeKey({ parent: item.parent, segmentKey: item.segmentKey, orderKey: item.orderKey });
    if (item.state === 'active' && isContainerRole(input.profile, item.role)) {
      if (stack.some(ancestor => ancestor.parent === item.occurrence)) throw new WorkReadUnavailable('Hierarchy repeats a container');
      stack.push({ parent: item.occurrence });
    }
  }
  // The caller can persist only sibling anchors; buffers are local to this call.
  for (const frame of stack) { delete frame.pending; delete frame.at; delete frame.more; }
  return { occurrences: taken.filter(item => item.state === 'active'),
    parentReads, emptyReads, dataReads, pagesRead };
}
