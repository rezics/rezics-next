import { expect, test } from 'bun:test';
import type { OrderedHostedPlacement, HostedChapterTarget } from '../../src/content/hosted-chapters-model.ts';
import {
  HostedVersionPublicationWriteError,
  type HostedVersionPublicationIndexRoots,
  type HostedVersionPublicationOccurrence,
  type HostedVersionPublicationOccurrenceChange,
  type HostedVersionPublicationWritePort,
} from '../../src/content/hosted-version-publication-write-model.ts';
import { writeHostedVersionPublicationPoint } from '../../src/content/hosted-version-publication-write.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import type { HostedPointSelection } from '../../src/content/hosted-publication-point-selection.ts';

type Index = VersionedOutlineSequenceReadWriteSet<string>;
type Tree = Readonly<{ rootId: string | null; nodes: ReadonlyMap<string, VersionedOutlineSequenceNode<string>> }>;
type Fixture = Readonly<{
  port: HostedVersionPublicationWritePort;
  indexes: Readonly<{ siblings: Index; preorder: Index; chapters: Index }>;
  oldRoots: HostedVersionPublicationIndexRoots;
  oldSiblingRootId: string;
  occurrences: ReadonlyMap<string, HostedVersionPublicationOccurrence>;
  stagedOccurrences: Map<string, HostedVersionPublicationOccurrenceChange>;
  stagedSiblingRoots: Map<string | null, string | null>;
  stagedSnapshotRoots: { value: HostedVersionPublicationIndexRoots | null };
  trees: Readonly<{ siblings: Tree; preorder: Tree; chapters: Tree }>;
}>;

const OLD_SIZE = 2048;

function target(revisionId: string): HostedChapterTarget {
  return {
    threadId: 'thread-1',
    postId: 'post-1',
    revisionId,
    sha256: revisionId.padEnd(64, '0'),
  };
}

function chapter(occurrenceId: string, ordinal: number, revisionId = `revision-${ordinal}`): OrderedHostedPlacement {
  return {
    occurrenceId,
    parentId: null,
    kind: 'chapter',
    position: ordinal,
    ordinal,
    title: `Chapter ${ordinal}`,
    target: target(revisionId),
  };
}

function buildTree(values: readonly string[]): Tree {
  const nodes = new Map<string, VersionedOutlineSequenceNode<string>>();

  function build(start: number, end: number, parentId: string | null): string | null {
    if (start >= end) return null;
    const middle = Math.floor((start + end) / 2);
    const id = values[middle]!;
    const leftId = build(start, middle, id);
    const rightId = build(middle + 1, end, id);
    const left = leftId === null ? null : nodes.get(leftId)!;
    const right = rightId === null ? null : nodes.get(rightId)!;
    nodes.set(id, {
      id,
      value: id,
      leftId,
      rightId,
      treeParentId: parentId,
      height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
      count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
      chapterWeight: 1n,
      chapterCount: 1n + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    });
    return id;
  }

  return { rootId: build(0, values.length, null), nodes };
}

function makeIndex(tree: Tree): Index {
  return createVersionedOutlineSequenceReadWriteSet(async (id) => tree.nodes.get(id) ?? null);
}

function fixture(): Fixture {
  const ids = Array.from({ length: OLD_SIZE }, (_, index) => `chapter-${String(index).padStart(4, '0')}`);
  const siblingsTree = buildTree(ids);
  const preorderTree = buildTree(ids);
  const chaptersTree = buildTree(ids);
  const indexes = {
    siblings: makeIndex(siblingsTree),
    preorder: makeIndex(preorderTree),
    chapters: makeIndex(chaptersTree),
  };
  const oldRoots: HostedVersionPublicationIndexRoots = {
    preorderRootId: preorderTree.rootId,
    chapterRootId: chaptersTree.rootId,
    placementCount: BigInt(OLD_SIZE),
    chapterCount: BigInt(OLD_SIZE),
  };
  const occurrences = new Map<string, HostedVersionPublicationOccurrence>(
    ids.map((id, index) => [
      id,
      {
        parentId: null,
        subtreeSize: 1n,
        chapterCount: 1n,
        value: { kind: 'chapter', title: `Chapter ${index}`, target: target(`revision-${index}`) },
      },
    ]),
  );
  const stagedOccurrences = new Map<string, HostedVersionPublicationOccurrenceChange>();
  const stagedSiblingRoots = new Map<string | null, string | null>();
  const stagedSnapshotRoots = { value: null as HostedVersionPublicationIndexRoots | null };
  const port: HostedVersionPublicationWritePort = {
    snapshot: {
      publicationRevisionId: 'publication-current',
      generationId: 'candidate-generation',
      generationKind: 'candidate',
      sequence: 17n,
      ...oldRoots,
    },
    indexes,
    async readOccurrence(id) {
      return occurrences.get(id) ?? null;
    },
    async readSiblingRoot(parentId) {
      return parentId === null ? siblingsTree.rootId : null;
    },
    stageOccurrence(change) {
      stagedOccurrences.set(change.occurrenceId, change);
    },
    stageSiblingRoot(parentId, rootId) {
      stagedSiblingRoots.set(parentId, rootId);
    },
    stageSnapshotRoots(roots) {
      stagedSnapshotRoots.value = roots;
    },
  };
  return {
    port,
    indexes,
    oldRoots,
    oldSiblingRootId: siblingsTree.rootId!,
    occurrences,
    stagedOccurrences,
    stagedSiblingRoots,
    stagedSnapshotRoots,
    trees: { siblings: siblingsTree, preorder: preorderTree, chapters: chaptersTree },
  };
}

function insertSelection(beforeOccurrenceId: string): Extract<HostedPointSelection, { kind: 'publishChapter' }> {
  const before = chapter(beforeOccurrenceId, Number(beforeOccurrenceId.slice(-4)));
  const selectedPart: OrderedHostedPlacement = {
    occurrenceId: 'part-new',
    parentId: null,
    kind: 'part',
    position: Number(beforeOccurrenceId.slice(-4)),
    ordinal: Number(beforeOccurrenceId.slice(-4)),
    title: 'New part',
  };
  const selected = { ...chapter('chapter-new', OLD_SIZE, 'revision-new'), parentId: 'part-new' };
  return {
    kind: 'publishChapter',
    expectedRevisionId: 'draft-current',
    expectedPublicationId: 'publication-current',
    chapter: selected,
    ancestors: [{ placement: selectedPart, before }],
    parentId: 'part-new',
    beforeOccurrenceId: null,
    parent: null,
    before: null,
    changedPlacements: [selected],
  };
}

function replaceSelection(occurrenceId: string): Extract<HostedPointSelection, { kind: 'replacePublishedChapter' }> {
  const ordinal = Number(occurrenceId.slice(-4));
  const publicChapter = chapter(occurrenceId, ordinal);
  const draftChapter = chapter(occurrenceId, ordinal, `revision-new-${ordinal}`);
  return {
    kind: 'replacePublishedChapter',
    expectedRevisionId: 'draft-current',
    expectedPublicationId: 'publication-current',
    publicChapter,
    draftChapter,
    changedPlacements: [draftChapter],
  };
}

async function inOrder(index: Index, rootId: string | null): Promise<string[]> {
  if (rootId === null) return [];
  const node = await index.readNode(rootId);
  if (node === null) throw new Error('Test sequence root is missing');
  return [...(await inOrder(index, node.leftId)), node.value, ...(await inOrder(index, node.rightId))];
}

test('inserts a selected ancestor and chapter into one exact large public baseline', async () => {
  const state = fixture();
  const selectedRank = OLD_SIZE / 2;
  const beforeId = `chapter-${String(selectedRank).padStart(4, '0')}`;
  const plan = await writeHostedVersionPublicationPoint(insertSelection(beforeId), state.port);

  const updatedIds = await inOrder(state.indexes.preorder, plan.roots.preorderRootId);
  expect(updatedIds).toHaveLength(OLD_SIZE + 2);
  expect(updatedIds.slice(selectedRank - 1, selectedRank + 3)).toEqual([
    `chapter-${String(selectedRank - 1).padStart(4, '0')}`,
    'part-new',
    'chapter-new',
    beforeId,
  ]);
  expect(plan.insertions).toEqual([
    {
      occurrenceId: 'part-new',
      parentId: null,
      kind: 'part',
      siblingRank: BigInt(selectedRank),
      preorderRank: BigInt(selectedRank),
      chapterRank: null,
    },
    {
      occurrenceId: 'chapter-new',
      parentId: 'part-new',
      kind: 'chapter',
      siblingRank: 0n,
      preorderRank: BigInt(selectedRank + 1),
      chapterRank: BigInt(selectedRank),
    },
  ]);
  expect(plan.roots.placementCount).toBe(BigInt(OLD_SIZE + 2));
  expect(plan.roots.chapterCount).toBe(BigInt(OLD_SIZE + 1));
  expect(state.stagedOccurrences.size).toBe(2);
  expect(state.stagedOccurrences.get('part-new')).toMatchObject({ subtreeSize: 2n, chapterCount: 1n });
  expect(state.stagedSiblingRoots.size).toBe(2);
  expect(state.stagedSnapshotRoots.value).toEqual(plan.roots);

  const logicalIndexPathNodes =
    plan.logicalWork.siblings.writtenNodeCount +
    plan.logicalWork.preorder.writtenNodeCount +
    plan.logicalWork.chapters.writtenNodeCount;
  expect(plan.logicalWork.touchedIndexPathNodes).toBe(logicalIndexPathNodes);
  expect(logicalIndexPathNodes).toBeLessThan(512);
  expect(state.trees.preorder.rootId).toBe(state.oldRoots.preorderRootId);
  expect(state.trees.chapters.rootId).toBe(state.oldRoots.chapterRootId);
  expect(state.trees.siblings.rootId).toBe(state.oldSiblingRootId);
  expect(state.trees.preorder.nodes.get(beforeId)?.value).toBe(beforeId);
  expect(state.occurrences.get(beforeId)?.value).toEqual({
    kind: 'chapter',
    title: `Chapter ${selectedRank}`,
    target: target(`revision-${selectedRank}`),
  });
  expect(plan.expectedSequence).toBe(17n);
  expect(plan.nextSequence).toBe(18n);
});

test('replacement changes one selected value without changing public placement or an older root', async () => {
  const state = fixture();
  const occurrenceId = `chapter-${String(OLD_SIZE / 2).padStart(4, '0')}`;
  const plan = await writeHostedVersionPublicationPoint(replaceSelection(occurrenceId), state.port);

  expect(plan.insertions).toEqual([]);
  expect(plan.roots).toEqual(state.oldRoots);
  expect(plan.logicalWork.touchedIndexPathNodes).toBe(0);
  expect(plan.occurrenceChanges).toEqual([
    {
      occurrenceId,
      ...state.occurrences.get(occurrenceId)!,
      value: {
        kind: 'chapter',
        title: `Chapter ${OLD_SIZE / 2}`,
        target: target(`revision-new-${OLD_SIZE / 2}`),
      },
    },
  ]);
  expect(state.stagedOccurrences.size).toBe(1);
  expect(state.stagedSiblingRoots.size).toBe(0);
  expect(state.stagedSnapshotRoots.value).toBeNull();
  expect(state.trees.preorder.rootId).toBe(state.oldRoots.preorderRootId);
  expect(state.trees.chapters.rootId).toBe(state.oldRoots.chapterRootId);
  expect(state.occurrences.get(occurrenceId)?.value).toEqual({
    kind: 'chapter',
    title: `Chapter ${OLD_SIZE / 2}`,
    target: target(`revision-${OLD_SIZE / 2}`),
  });
  expect(plan.logicalWork.changedOccurrences).toBe(1);
});

test('a mismatched publication snapshot is rejected before any index or occurrence write', async () => {
  const state = fixture();
  const stale = insertSelection('chapter-1024');
  await expect(
    writeHostedVersionPublicationPoint({ ...stale, expectedPublicationId: 'publication-obsolete' }, state.port),
  ).rejects.toBeInstanceOf(HostedVersionPublicationWriteError);
  expect(state.indexes.siblings.nodeWrites.size).toBe(0);
  expect(state.indexes.preorder.nodeWrites.size).toBe(0);
  expect(state.indexes.chapters.nodeWrites.size).toBe(0);
  expect(state.stagedOccurrences.size).toBe(0);
  expect(state.stagedSiblingRoots.size).toBe(0);
});
