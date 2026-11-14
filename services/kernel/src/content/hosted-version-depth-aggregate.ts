import {
  maximumVersionedOutlineSequenceSubtreeHeight,
  setVersionedOutlineSequenceSubtreeHeight,
  type VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';

export type HostedVersionDepthFact = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  /** Ancestor summaries need not repeat kind; selected source facts do. */
  kind?: 'part' | 'chapter';
  subtreeHeight: number;
}>;

export type HostedVersionDepthMaximum = Readonly<{
  occurrenceId: string;
  subtreeHeight: number;
}>;

export type HostedVersionDepthIndexes = Readonly<{
  siblings: VersionedOutlineSequenceReadWriteSet<string>;
  preorder: VersionedOutlineSequenceReadWriteSet<string>;
  siblingRootByParent: ReadonlyMap<string | null, string | null>;
  preorderRootId: string | null;
  readLegacyMaximum: (
    parentId: string | null,
    excludedOccurrenceIds: readonly string[],
  ) => Promise<HostedVersionDepthMaximum | null>;
}>;

export type HostedVersionDepthChanges = Map<string | null, Map<string, number | null>>;

export type HostedVersionDepthUpdate = Readonly<{
  occurrenceId: string;
  subtreeHeight: number;
}>;

function recordHeightChange(
  changes: HostedVersionDepthChanges,
  parentId: string | null,
  occurrenceId: string,
  subtreeHeight: number | null,
): void {
  const children = changes.get(parentId) ?? new Map<string, number | null>();
  children.set(occurrenceId, subtreeHeight);
  changes.set(parentId, children);
}

function changedChildren(changes: HostedVersionDepthChanges, parentId: string | null): Map<string, number | null> {
  const children = changes.get(parentId);
  if (children) return children;
  const created = new Map<string, number | null>();
  changes.set(parentId, created);
  return created;
}

async function maximumChildHeight(
  indexes: HostedVersionDepthIndexes,
  parentId: string | null,
  rootOverrides: ReadonlyMap<string | null, string | null>,
  changes: HostedVersionDepthChanges,
): Promise<number | null> {
  const rootId = rootOverrides.has(parentId)
    ? rootOverrides.get(parentId)!
    : (indexes.siblingRootByParent.get(parentId) ?? null);
  const maximum = await maximumVersionedOutlineSequenceSubtreeHeight(indexes.siblings, rootId);
  if (maximum.complete) return maximum.subtreeHeight;

  const pending = changedChildren(changes, parentId);
  const legacy = await indexes.readLegacyMaximum(parentId, [...pending.keys()]);
  let height = legacy?.subtreeHeight ?? null;
  for (const pendingHeight of pending.values()) {
    if (pendingHeight !== null && (height === null || pendingHeight > height)) height = pendingHeight;
  }
  return height;
}

async function updateOccurrenceHeight(
  indexes: HostedVersionDepthIndexes,
  fact: HostedVersionDepthFact,
  subtreeHeight: number,
  rootOverrides: ReadonlyMap<string | null, string | null>,
  changes: HostedVersionDepthChanges,
  updates: Map<string, HostedVersionDepthUpdate>,
): Promise<void> {
  const siblingRootId = rootOverrides.has(fact.parentId)
    ? rootOverrides.get(fact.parentId)!
    : (indexes.siblingRootByParent.get(fact.parentId) ?? null);
  await setVersionedOutlineSequenceSubtreeHeight(indexes.siblings, siblingRootId, fact.occurrenceId, subtreeHeight);
  await setVersionedOutlineSequenceSubtreeHeight(
    indexes.preorder,
    indexes.preorderRootId,
    fact.occurrenceId,
    subtreeHeight,
  );
  if (subtreeHeight !== fact.subtreeHeight) {
    recordHeightChange(changes, fact.parentId, fact.occurrenceId, subtreeHeight);
    updates.set(fact.occurrenceId, { occurrenceId: fact.occurrenceId, subtreeHeight });
  }
}

/** Derive a part's height from the selected child-list maximum, falling back only for legacy nodes. */
export async function deriveHostedVersionSubtreeHeight(
  indexes: HostedVersionDepthIndexes,
  occurrenceId: string,
  kind: 'part' | 'chapter',
): Promise<number> {
  if (kind === 'chapter') return 0;
  const maximum = await maximumChildHeight(indexes, occurrenceId, new Map(), new Map());
  return maximum === null ? 0 : maximum + 1;
}

/** Record an inserted or removed child in the legacy-summary overlay before recomputing its parent path. */
export function recordHostedVersionDepthChange(
  changes: HostedVersionDepthChanges,
  parentId: string | null,
  occurrenceId: string,
  subtreeHeight: number | null,
): void {
  recordHeightChange(changes, parentId, occurrenceId, subtreeHeight);
}

/** Recompute a bottom-up containment path; every value update touches two AVL search paths. */
export async function recomputeHostedVersionAncestorHeights(
  indexes: HostedVersionDepthIndexes,
  ancestors: readonly HostedVersionDepthFact[],
  rootOverrides: ReadonlyMap<string | null, string | null>,
  changes: HostedVersionDepthChanges,
): Promise<readonly HostedVersionDepthUpdate[]> {
  const updates = new Map<string, HostedVersionDepthUpdate>();
  for (const ancestor of ancestors) {
    if (ancestor.kind === 'chapter') throw new Error('Hosted chapter cannot contain nested placements');
    const maximum = await maximumChildHeight(indexes, ancestor.occurrenceId, rootOverrides, changes);
    const height = maximum === null ? 0 : maximum + 1;
    await updateOccurrenceHeight(indexes, ancestor, height, rootOverrides, changes, updates);
  }
  return [...updates.values()];
}

/** Keep a moved occurrence's repaired measure aligned with its new sibling and preorder values. */
export async function repairHostedVersionOccurrenceHeight(
  indexes: HostedVersionDepthIndexes,
  occurrence: HostedVersionDepthFact,
  subtreeHeight: number,
  destinationParentId: string | null,
  destinationSiblingRootId: string | null,
  changes: HostedVersionDepthChanges,
): Promise<HostedVersionDepthUpdate | null> {
  const moved = { ...occurrence, parentId: destinationParentId };
  const roots = new Map([[destinationParentId, destinationSiblingRootId]]);
  const updates = new Map<string, HostedVersionDepthUpdate>();
  await updateOccurrenceHeight(indexes, moved, subtreeHeight, roots, changes, updates);
  return updates.get(occurrence.occurrenceId) ?? null;
}

export function createHostedVersionDepthChanges(): HostedVersionDepthChanges {
  return new Map();
}
