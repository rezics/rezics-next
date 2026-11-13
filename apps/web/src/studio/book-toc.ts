import type { BookPlacement, BookStructure, BookStructureChange, ExactDocument, PublicationTarget } from './contract';

export type BookTocRow = Readonly<{
  placement: BookPlacement;
  depth: number;
  ancestors: readonly string[];
  siblings: readonly BookPlacement[];
  index: number;
}>;

/** Adapt an admitted bounded ordered placement set; preserve occurrence IDs and exact Post addresses. */
export function bookTocRows(structure: BookStructure): readonly BookTocRow[] {
  const { placements, limits } = structure;
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 1 ||
    limits.maxDepth > 64 ||
    !Number.isSafeInteger(limits.maxPlacements) ||
    limits.maxPlacements < 1 ||
    placements.length > limits.maxPlacements
  )
    throw new Error('The table of contents exceeds its admitted bounds.');
  const byId = new Map<string, BookPlacement>();
  const children = new Map<string | null, BookPlacement[]>();
  for (const placement of placements) {
    if (!placement.occurrenceId || byId.has(placement.occurrenceId))
      throw new Error('The table of contents contains duplicate occurrence identities.');
    byId.set(placement.occurrenceId, placement);
    const siblings = children.get(placement.parentOccurrenceId) ?? [];
    siblings.push(placement);
    children.set(placement.parentOccurrenceId, siblings);
  }
  for (const placement of placements) {
    if (placement.parentOccurrenceId !== null && byId.get(placement.parentOccurrenceId)?.target.kind !== 'part')
      throw new Error('A chapter or missing occurrence cannot contain children.');
  }
  const rows: BookTocRow[] = [];
  const visit = (parent: string | null, ancestors: readonly string[]) => {
    const siblings = children.get(parent) ?? [];
    for (const [index, placement] of siblings.entries()) {
      if (ancestors.length >= limits.maxDepth || ancestors.includes(placement.occurrenceId))
        throw new Error('The table of contents contains a cycle or exceeds its nesting limit.');
      rows.push({ placement, depth: ancestors.length, ancestors, siblings, index });
      visit(placement.occurrenceId, [...ancestors, placement.occurrenceId]);
    }
  };
  visit(null, []);
  if (rows.length !== placements.length) throw new Error('The table of contents contains an unreachable branch.');
  return rows;
}

export type BookTocIndex = Readonly<{
  rows: readonly BookTocRow[];
  byId: ReadonlyMap<string, BookTocRow>;
  children: ReadonlyMap<string | null, readonly BookTocRow[]>;
  /** Absolute deepest row depth in each subtree, including the row itself. */
  maxDescendantDepth: ReadonlyMap<string, number>;
  maxDepth: number;
}>;

/** Index the admitted preorder projection in linear time without changing occurrence identity or order. */
export function bookTocIndex(structure: BookStructure): BookTocIndex {
  const rows = bookTocRows(structure);
  const byId = new Map<string, BookTocRow>();
  const children = new Map<string | null, BookTocRow[]>([[null, []]]);
  const maxDescendantDepth = new Map<string, number>();
  for (const row of rows) {
    const { occurrenceId, parentOccurrenceId } = row.placement;
    byId.set(occurrenceId, row);
    const siblings = children.get(parentOccurrenceId) ?? [];
    siblings.push(row);
    children.set(parentOccurrenceId, siblings);
    maxDescendantDepth.set(occurrenceId, row.depth);
  }
  // Children precede their parents in reverse preorder, so each completed subtree updates its parent once.
  for (let index = rows.length - 1; index >= 0; index--) {
    const { occurrenceId, parentOccurrenceId } = rows[index]!.placement;
    if (parentOccurrenceId !== null)
      maxDescendantDepth.set(
        parentOccurrenceId,
        Math.max(maxDescendantDepth.get(parentOccurrenceId)!, maxDescendantDepth.get(occurrenceId)!),
      );
  }
  return { rows, byId, children, maxDescendantDepth, maxDepth: structure.limits.maxDepth };
}

export function bookPublicationTarget(
  structure: BookStructure,
  selected: ReadonlySet<string>,
): PublicationTarget | null {
  const chapters = bookTocRows(structure).flatMap(({ placement }) =>
    placement.target.kind === 'chapter' && selected.has(placement.occurrenceId)
      ? [{ occurrenceId: placement.occurrenceId, document: placement.target.document }]
      : [],
  );
  if (!chapters.length) return null;
  return { kind: 'book', catalogueId: structure.catalogueId, structureRevision: structure.revision, chapters };
}

/** All movements are expressed by stable sibling identities, never by array offsets sent to native. */
export function moveBookOccurrence(
  row: BookTocRow,
  direction: 'up' | 'down' | 'in' | 'out',
  outline: BookTocIndex,
): BookStructureChange | null {
  const { placement, siblings, index } = row;
  let parentOccurrenceId = placement.parentOccurrenceId;
  let beforeOccurrenceId: string | null;
  if (direction === 'up') {
    const previous = siblings[index - 1];
    if (!previous) return null;
    beforeOccurrenceId = previous.occurrenceId;
  } else if (direction === 'down') {
    if (!siblings[index + 1]) return null;
    beforeOccurrenceId = siblings[index + 2]?.occurrenceId ?? null;
  } else if (direction === 'in') {
    const previous = siblings[index - 1];
    if (
      previous?.target.kind !== 'part' ||
      outline.maxDescendantDepth.get(placement.occurrenceId)! + 1 >= outline.maxDepth
    )
      return null;
    parentOccurrenceId = previous.occurrenceId;
    beforeOccurrenceId = null;
  } else {
    const parent = placement.parentOccurrenceId === null ? undefined : outline.byId.get(placement.parentOccurrenceId);
    if (!parent) return null;
    parentOccurrenceId = parent.placement.parentOccurrenceId;
    beforeOccurrenceId = parent.siblings[parent.index + 1]?.occurrenceId ?? null;
  }
  return { kind: 'move', occurrenceId: placement.occurrenceId, parentOccurrenceId, beforeOccurrenceId };
}

export function selectedChapter(structure: BookStructure, occurrenceId: string): ExactDocument | null {
  const placement = structure.placements.find((entry) => entry.occurrenceId === occurrenceId);
  return placement?.target.kind === 'chapter' ? placement.target.document : null;
}

/** Resolve a destination against this revision, including the full moved subtree's depth. */
export function moveBookOccurrenceTo(
  occurrenceId: string,
  parentOccurrenceId: string | null,
  beforeOccurrenceId: string | null,
  outline: BookTocIndex,
): Extract<BookStructureChange, { kind: 'move' }> | null {
  const source = outline.byId.get(occurrenceId);
  if (!source) return null;
  const parent = parentOccurrenceId === null ? null : outline.byId.get(parentOccurrenceId);
  if (
    parentOccurrenceId !== null &&
    (!parent ||
      parent.placement.target.kind !== 'part' ||
      parentOccurrenceId === occurrenceId ||
      parent.ancestors.includes(occurrenceId))
  )
    return null;
  const depth = parent ? parent.depth + 1 : 0;
  if (outline.maxDescendantDepth.get(occurrenceId)! - source.depth + depth >= outline.maxDepth) return null;
  if (beforeOccurrenceId !== null) {
    const before = outline.byId.get(beforeOccurrenceId);
    if (!before || beforeOccurrenceId === occurrenceId || before.placement.parentOccurrenceId !== parentOccurrenceId)
      return null;
  }
  // The next sibling (or end for the last sibling) is the source's existing insertion point.
  if (
    source.placement.parentOccurrenceId === parentOccurrenceId &&
    (source.siblings[source.index + 1]?.occurrenceId ?? null) === beforeOccurrenceId
  )
    return null;
  return { kind: 'move', occurrenceId, parentOccurrenceId, beforeOccurrenceId };
}

/** Stable sibling anchors, followed by an explicit end option when it changes the order. */
export function bookMovePositions(
  occurrenceId: string,
  parentOccurrenceId: string | null,
  outline: BookTocIndex,
): readonly (string | null)[] {
  const anchors = (outline.children.get(parentOccurrenceId) ?? []).map((row) => row.placement.occurrenceId);
  return [...anchors, null].filter((before) => moveBookOccurrenceTo(occurrenceId, parentOccurrenceId, before, outline));
}

/** Enumerate only destinations with at least one effective move; child lists are already indexed. */
export function bookMoveDestinations(occurrenceId: string, outline: BookTocIndex): readonly (string | null)[] {
  const parts = outline.rows
    .filter((row) => row.placement.target.kind === 'part')
    .map((row) => row.placement.occurrenceId);
  return [null, ...parts].filter((parent) => bookMovePositions(occurrenceId, parent, outline).length > 0);
}
