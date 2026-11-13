import { expect, test } from 'bun:test';
import {
  readHostedVersionChapterPage,
  readHostedVersionChildrenPage,
  readHostedVersionOutlinePage,
} from '../../src/content/hosted-version-read-pages.ts';
import {
  HostedVersionReadAnchorError,
  type HostedVersionReadIndex,
  type HostedVersionReadPage,
} from '../../src/content/hosted-version-read-pages-model.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
} from '../../src/content/versioned-outline-sequence.ts';

type PlacementValue = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  kind: 'part' | 'chapter';
  targetRevisionId: string;
}>;

type Snapshot = Readonly<{
  rootId: string | null;
  nodes: ReadonlyMap<string, VersionedOutlineSequenceNode<PlacementValue>>;
}>;

function placement(occurrenceId: string, ordinal: number, kind: PlacementValue['kind']): PlacementValue {
  return {
    occurrenceId,
    parentId: kind === 'part' ? null : 'part-root',
    kind,
    targetRevisionId: 'target-old-' + String(ordinal),
  };
}

function buildSnapshot(values: readonly PlacementValue[]): Snapshot {
  const nodes = new Map<string, VersionedOutlineSequenceNode<PlacementValue>>();

  function build(start: number, end: number, treeParentId: string | null): string | null {
    if (start === end) return null;
    const middle = Math.floor((start + end) / 2);
    const value = values[middle]!;
    const id = value.occurrenceId;
    const leftId = build(start, middle, id);
    const rightId = build(middle + 1, end, id);
    const left = leftId === null ? null : nodes.get(leftId)!;
    const right = rightId === null ? null : nodes.get(rightId)!;
    const chapterWeight = value.kind === 'chapter' ? 1n : 0n;
    nodes.set(id, {
      id,
      value,
      leftId,
      rightId,
      treeParentId,
      height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
      count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
      ...(chapterWeight === 0n ? {} : { chapterWeight }),
      chapterCount: chapterWeight + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    });
    return id;
  }

  return { rootId: build(0, values.length, null), nodes };
}

function selectedIndex(snapshot: Snapshot): HostedVersionReadIndex<PlacementValue> {
  return {
    rootId: snapshot.rootId,
    access: createVersionedOutlineSequenceReadWriteSet(async (id) => snapshot.nodes.get(id) ?? null),
  };
}

function siblingValues(count: number): PlacementValue[] {
  return Array.from({ length: count }, (_, ordinal) =>
    placement('s' + String(ordinal).padStart(3, '0'), ordinal, ordinal % 4 === 0 ? 'part' : 'chapter'),
  );
}

function outlineValues(count: number): PlacementValue[] {
  return Array.from({ length: count }, (_, ordinal) => {
    const kind = ordinal % 4 === 0 ? 'part' : 'chapter';
    const value = placement('o' + String(ordinal).padStart(3, '0'), ordinal, kind);
    return ordinal === 128 ? { ...value, parentId: null } : value;
  });
}

function assertLogicalWork<Value>(
  page: HostedVersionReadPage<unknown>,
  roots: readonly (VersionedOutlineSequenceNode<Value> | undefined)[],
  limit: number,
): void {
  const height = roots.reduce((sum, root) => sum + (root?.height ?? 0), 0);
  const bound = 8 * (height + limit + 2) + 16;
  expect(page.work.logicalNodeReadCalls).toBeLessThanOrEqual(bound);
  expect(page.work.distinctLogicalNodeVisits).toBeLessThanOrEqual(bound);
  expect(page.work.snapshotProbeCount).toBeLessThanOrEqual(bound);
}

function rootNode(snapshot: Snapshot): VersionedOutlineSequenceNode<PlacementValue> | undefined {
  return snapshot.rootId === null ? undefined : snapshot.nodes.get(snapshot.rootId);
}

test('pinned sibling, preorder and chapter pages retain their old roots after edits', async () => {
  const oldSiblings = buildSnapshot(siblingValues(127));
  const changedSiblings = siblingValues(127);
  const movedSibling = changedSiblings.splice(50, 1)[0]!;
  changedSiblings.splice(70, 0, { ...movedSibling, targetRevisionId: 'target-new' });
  changedSiblings.push(placement('s-new', 128, 'chapter'));
  const currentSiblings = buildSnapshot(changedSiblings);

  const oldOutline = buildSnapshot(outlineValues(255));
  const changedOutline = outlineValues(255);
  [changedOutline[68], changedOutline[69]] = [changedOutline[69]!, changedOutline[68]!];
  changedOutline[68] = { ...changedOutline[68]!, targetRevisionId: 'target-new' };
  changedOutline[128] = { ...changedOutline[128]!, targetRevisionId: 'target-new' };
  changedOutline.push(placement('o-new', 255, 'chapter'));
  const currentOutline = buildSnapshot(changedOutline);

  const oldChapters = buildSnapshot(outlineValues(255).filter((entry) => entry.kind === 'chapter'));
  const currentChapters = buildSnapshot(changedOutline.filter((entry) => entry.kind === 'chapter'));
  const oldOriginId = 'o128';

  const children = await readHostedVersionChildrenPage(selectedIndex(oldSiblings), {
    afterNodeId: 's050',
    limit: 3,
  });
  expect(children.candidates.map((candidate) => [candidate.value.occurrenceId, candidate.position])).toEqual([
    ['s051', 51],
    ['s052', 52],
    ['s053', 53],
    ['s054', 54],
  ]);
  expect(children.nextAnchorId).toBe('s053');
  expect(children.hasMore).toBe(true);
  expect(children.candidates.every((candidate) => candidate.value.targetRevisionId.startsWith('target-old-'))).toBe(
    true,
  );

  const childContinuation = await readHostedVersionChildrenPage(selectedIndex(oldSiblings), {
    afterNodeId: children.nextAnchorId!,
    limit: 3,
  });
  expect(childContinuation.candidates.map((candidate) => candidate.position)).toEqual([54, 55, 56, 57]);
  const currentChildren = await readHostedVersionChildrenPage(selectedIndex(currentSiblings), {
    afterNodeId: 's050',
    limit: 1,
  });
  expect(currentChildren.candidates[0]).toMatchObject({
    value: { occurrenceId: 's071', targetRevisionId: 'target-old-71' },
    position: 71,
  });
  expect(currentSiblings.nodes.get('s050')?.value.targetRevisionId).toBe('target-new');

  const outline = await readHostedVersionOutlinePage(selectedIndex(oldOutline), {
    afterNodeId: 'o067',
    limit: 2,
  });
  expect(outline.candidates.map((candidate) => [candidate.value.occurrenceId, candidate.ordinal])).toEqual([
    ['o068', 68],
    ['o069', 69],
    ['o070', 70],
  ]);
  const currentPreorder = await readHostedVersionOutlinePage(selectedIndex(currentOutline), {
    afterNodeId: 'o067',
    limit: 2,
  });
  expect(currentPreorder.candidates.map((candidate) => candidate.value.occurrenceId)).toEqual(['o069', 'o068', 'o070']);
  expect(currentPreorder.candidates[0]?.value.targetRevisionId).toBe('target-new');

  const previous = await readHostedVersionChapterPage(selectedIndex(oldOutline), selectedIndex(oldChapters), {
    originNodeId: oldOriginId,
    direction: 'previous',
    limit: 2,
  });
  const next = await readHostedVersionChapterPage(selectedIndex(oldOutline), selectedIndex(oldChapters), {
    originNodeId: oldOriginId,
    direction: 'next',
    limit: 2,
  });
  const oldOutlineEntries = outlineValues(255);
  const chapterIds = oldOutlineEntries.filter((entry) => entry.kind === 'chapter').map((entry) => entry.occurrenceId);
  const originChapterRank = oldOutlineEntries.slice(0, 128).filter((entry) => entry.kind === 'chapter').length;
  expect(previous.candidates.map((candidate) => candidate.value.occurrenceId)).toEqual([
    chapterIds[originChapterRank - 1]!,
    chapterIds[originChapterRank - 2]!,
    chapterIds[originChapterRank - 3]!,
  ]);
  expect(next.candidates.map((candidate) => candidate.value.occurrenceId)).toEqual([
    chapterIds[originChapterRank]!,
    chapterIds[originChapterRank + 1]!,
    chapterIds[originChapterRank + 2]!,
  ]);
  expect(previous.candidates[0]?.rank).toBe(BigInt(originChapterRank - 1));
  expect(next.candidates[0]?.value.targetRevisionId.startsWith('target-old-')).toBe(true);

  const previousContinuation = await readHostedVersionChapterPage(
    selectedIndex(oldOutline),
    selectedIndex(oldChapters),
    {
      originNodeId: oldOriginId,
      direction: 'previous',
      afterNodeId: previous.nextAnchorId!,
      limit: 2,
    },
  );
  const nextContinuation = await readHostedVersionChapterPage(selectedIndex(oldOutline), selectedIndex(oldChapters), {
    originNodeId: oldOriginId,
    direction: 'next',
    afterNodeId: next.nextAnchorId!,
    limit: 2,
  });
  expect(previousContinuation.candidates.map((candidate) => candidate.value.occurrenceId)).toEqual([
    chapterIds[originChapterRank - 3]!,
    chapterIds[originChapterRank - 4]!,
    chapterIds[originChapterRank - 5]!,
  ]);
  expect(nextContinuation.candidates.map((candidate) => candidate.value.occurrenceId)).toEqual([
    chapterIds[originChapterRank + 2]!,
    chapterIds[originChapterRank + 3]!,
    chapterIds[originChapterRank + 4]!,
  ]);

  await expect(
    readHostedVersionChildrenPage(selectedIndex(oldSiblings), { afterNodeId: 's-new', limit: 2 }),
  ).rejects.toBeInstanceOf(HostedVersionReadAnchorError);
  await expect(
    readHostedVersionChapterPage(selectedIndex(oldOutline), selectedIndex(oldChapters), {
      originNodeId: 'o-new',
      direction: 'next',
      limit: 2,
    }),
  ).rejects.toBeInstanceOf(HostedVersionReadAnchorError);
  await expect(
    readHostedVersionChapterPage(selectedIndex(oldOutline), selectedIndex(oldChapters), {
      originNodeId: oldOriginId,
      direction: 'next',
      afterNodeId: chapterIds[0]!,
      limit: 2,
    }),
  ).rejects.toBeInstanceOf(HostedVersionReadAnchorError);

  // Logical node visits and selected-snapshot probes are separate measures.
  // The memory snapshot reader does not measure SQL statements or physical I/O.
  const siblingRoot = rootNode(oldSiblings);
  assertLogicalWork(children, [siblingRoot], 3);
  assertLogicalWork(outline, [rootNode(oldOutline)], 2);
  assertLogicalWork(next, [rootNode(oldOutline), rootNode(oldChapters)], 2);
  expect(children.work.logicalNodeReadCalls).toBeGreaterThan(children.work.distinctLogicalNodeVisits);
  expect(rootNode(currentChapters)?.count).toBe(rootNode(oldChapters)!.count + 1n);
});
