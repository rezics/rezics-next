import { expect, test } from 'bun:test';
import type { CommandTransaction } from '../../src/command/command.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceSnapshotReader,
} from '../../src/content/versioned-outline-sequence.ts';
import { commitHostedVersionDraftMoveInTransaction } from '../../src/content/hosted-version-draft-edit-command.ts';
import { prepareHostedVersionDraftMovePlan } from '../../src/content/hosted-version-draft-edit.ts';
import {
  HostedVersionDraftMoveError,
  type HostedVersionDraftMoveInput,
  type HostedVersionDraftMoveNativeAdapter,
  type HostedVersionDraftMoveIndexes,
  type HostedVersionDraftMoveSelection,
} from '../../src/content/hosted-version-draft-edit-model.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';

type Snapshot = Map<string, VersionedOutlineSequenceNode<string>>;

function buildSequence(values: readonly string[], weighted: ReadonlySet<string> = new Set()) {
  const nodes: Snapshot = new Map();
  function build(start: number, end: number, parentId: string | null): string | null {
    if (start >= end) return null;
    const middle = Math.floor((start + end) / 2);
    const id = values[middle]!;
    const leftId = build(start, middle, id);
    const rightId = build(middle + 1, end, id);
    const left = leftId === null ? null : nodes.get(leftId)!;
    const right = rightId === null ? null : nodes.get(rightId)!;
    const chapterWeight = weighted.has(id) ? 1n : 0n;
    nodes.set(id, {
      id,
      value: id,
      leftId,
      rightId,
      treeParentId: parentId,
      height: Math.max(left?.height ?? 0, right?.height ?? 0) + 1,
      count: 1n + (left?.count ?? 0n) + (right?.count ?? 0n),
      chapterWeight,
      chapterCount: chapterWeight + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
    });
    return id;
  }
  return { nodes, rootId: build(0, values.length, null) };
}

function makeIndexes(snapshots: Readonly<{ siblings: Snapshot; preorder: Snapshot; chapters: Snapshot }>) {
  const accesses = {
    siblings: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.siblings.get(id) ?? null),
    preorder: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.preorder.get(id) ?? null),
    chapters: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.chapters.get(id) ?? null),
  } satisfies HostedVersionDraftMoveIndexes;
  return accesses;
}

function commit(snapshot: Snapshot, access: HostedVersionDraftMoveIndexes[keyof HostedVersionDraftMoveIndexes]) {
  return new Map([...snapshot, ...access.nodeWrites]);
}

function materialize(snapshot: Snapshot, rootId: string | null): string[] {
  const result: string[] = [];
  function visit(id: string | null): void {
    if (id === null) return;
    const node = snapshot.get(id);
    if (!node) throw new Error('test oracle found a missing sequence node');
    visit(node.leftId);
    result.push(node.value);
    visit(node.rightId);
  }
  visit(rootId);
  return result;
}

test('moves a large unchanged subtree by ranks, preserves the old draft, and rejects stale or invalid anchors', async () => {
  const revisionId = 'draft-v7';
  const descendantIds = Array.from({ length: 12_000 }, (_, index) => `source-child-${index}`);
  const sourceChapterIds = descendantIds.filter((_, index) => index % 2 === 0);
  const sourceTargets = new Map(sourceChapterIds.map((id) => [id, `target-revision-${id}`]));
  const sourceChildren = ['source-part', ...descendantIds];
  const oldPreorder = [
    'parent-a',
    'a-before',
    ...sourceChildren,
    'a-after',
    'parent-b',
    'b-before',
    'b-after',
    'outside-tail',
  ];
  const oldChapters = ['a-before', ...sourceChapterIds, 'a-after', 'b-before', 'b-after', 'outside-tail'];
  const siblingA = buildSequence(['a-before', 'source-part', 'a-after']);
  const siblingB = buildSequence(['b-before', 'b-after']);
  const preorder = buildSequence(oldPreorder, new Set(oldChapters));
  const chapters = buildSequence(oldChapters, new Set(oldChapters));
  const siblingSnapshot = new Map([...siblingA.nodes, ...siblingB.nodes]);
  const original = {
    siblings: siblingSnapshot,
    preorder: preorder.nodes,
    chapters: chapters.nodes,
  };
  const selection: HostedVersionDraftMoveSelection = {
    snapshotId: revisionId,
    headRevisionId: revisionId,
    source: {
      snapshotId: revisionId,
      occurrenceId: 'source-part',
      parentId: 'parent-a',
      kind: 'part',
      subtreeSize: BigInt(sourceChildren.length),
      subtreeHeight: 1,
      chapterCount: BigInt(sourceChapterIds.length),
    },
    destinationParent: {
      snapshotId: revisionId,
      occurrenceId: 'parent-b',
      parentId: null,
      kind: 'part',
      subtreeSize: 3n,
      subtreeHeight: 1,
      chapterCount: 2n,
    },
    before: {
      snapshotId: revisionId,
      occurrenceId: 'b-before',
      parentId: 'parent-b',
      kind: 'chapter',
      subtreeSize: 1n,
      subtreeHeight: 0,
      chapterCount: 1n,
    },
    sourceAncestors: [
      { snapshotId: revisionId, occurrenceId: 'parent-a', parentId: null, subtreeSize: 12_004n, chapterCount: 6_002n },
    ],
    destinationAncestors: [
      { snapshotId: revisionId, occurrenceId: 'parent-b', parentId: null, subtreeSize: 3n, chapterCount: 2n },
    ],
    sourceSiblingRootId: siblingA.rootId,
    destinationSiblingRootId: siblingB.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
  };
  const input: HostedVersionDraftMoveInput = {
    expectedRevisionId: revisionId,
    occurrenceId: 'source-part',
    parentId: 'parent-b',
    beforeOccurrenceId: 'b-before',
  };
  const indexes = makeIndexes(original);
  const plan = await prepareHostedVersionDraftMovePlan(input, selection, indexes);
  const nextSiblings = commit(siblingSnapshot, indexes.siblings);
  const nextPreorder = commit(preorder.nodes, indexes.preorder);
  const nextChapters = commit(chapters.nodes, indexes.chapters);

  expect(plan.result).toBe('moved');
  expect(plan.ancestorDeltas).toEqual([
    {
      occurrenceId: 'parent-a',
      subtreeSizeDelta: -12_001n,
      chapterCountDelta: -6_000n,
      subtreeSize: 3n,
      chapterCount: 2n,
    },
    {
      occurrenceId: 'parent-b',
      subtreeSizeDelta: 12_001n,
      chapterCountDelta: 6_000n,
      subtreeSize: 12_004n,
      chapterCount: 6_002n,
    },
  ]);
  expect(materialize(nextSiblings, plan.sourceSiblingRootId)).toEqual(['a-before', 'a-after']);
  expect(materialize(nextSiblings, plan.destinationSiblingRootId)).toEqual(['source-part', 'b-before', 'b-after']);
  expect(materialize(nextPreorder, plan.preorderRootId)).toEqual([
    'parent-a',
    'a-before',
    'a-after',
    'parent-b',
    ...sourceChildren,
    'b-before',
    'b-after',
    'outside-tail',
  ]);
  expect(materialize(nextChapters, plan.chapterRootId)).toEqual([
    'a-before',
    'a-after',
    ...sourceChapterIds,
    'b-before',
    'b-after',
    'outside-tail',
  ]);
  expect([...sourceTargets]).toEqual(sourceChapterIds.map((id) => [id, `target-revision-${id}`]));
  expect(materialize(original.preorder, preorder.rootId)).toEqual(oldPreorder);
  expect(materialize(original.chapters, chapters.rootId)).toEqual(oldChapters);

  const logarithmicBound =
    64 * (preorder.nodes.get(preorder.rootId!)!.height + chapters.nodes.get(chapters.rootId!)!.height + 4);
  const totalProbes = plan.work.siblings.snapshotProbeCount + plan.work.preorder.snapshotProbeCount;
  const chapterProbes = plan.work.chapters.snapshotProbeCount;
  const totalWrites = plan.work.siblings.writtenNodeCount + plan.work.preorder.writtenNodeCount;
  const chapterWrites = plan.work.chapters.writtenNodeCount;
  expect(totalProbes + chapterProbes).toBeLessThan(logarithmicBound);
  expect(totalWrites + chapterWrites).toBeLessThan(logarithmicBound);
  expect(totalProbes + chapterProbes).toBeLessThan(Number(selection.source.subtreeSize));

  const staleIndexes = makeIndexes(original);
  await expect(
    prepareHostedVersionDraftMovePlan({ ...input, expectedRevisionId: 'draft-v6' }, selection, staleIndexes),
  ).rejects.toMatchObject({ code: 'stale-head' });

  const wrongParentAnchor: HostedVersionDraftMoveSelection = {
    ...selection,
    before: { ...selection.before!, occurrenceId: 'a-after', parentId: 'parent-a' },
  };
  const invalidIndexes = makeIndexes(original);
  await expect(
    prepareHostedVersionDraftMovePlan({ ...input, beforeOccurrenceId: 'a-after' }, wrongParentAnchor, invalidIndexes),
  ).rejects.toMatchObject({ code: 'invalid-anchor' });

  const noopIndexes = makeIndexes(original);
  const noOp = await prepareHostedVersionDraftMovePlan(
    { ...input, parentId: 'parent-a', beforeOccurrenceId: 'a-after' },
    {
      ...selection,
      destinationParent: { ...selection.destinationParent, occurrenceId: 'parent-a', subtreeSize: 12_004n },
      before: { ...selection.before!, occurrenceId: 'a-after', parentId: 'parent-a' },
      destinationAncestors: selection.sourceAncestors,
      destinationSiblingRootId: selection.sourceSiblingRootId,
    },
    noopIndexes,
  );
  expect(noOp.result).toBe('no-op');
  expect(noOp.work.siblings.writtenNodeCount + noOp.work.preorder.writtenNodeCount).toBe(0);
});

test('binds staged move roots to one adapter commit, skips adjacent no-ops, and rejects a lost head CAS', async () => {
  const revisionId = 'draft-v7';
  const input: HostedVersionDraftMoveInput = {
    expectedRevisionId: revisionId,
    occurrenceId: 'source',
    parentId: 'parent-b',
    beforeOccurrenceId: 'anchor',
  };
  const siblingA = buildSequence(['source']);
  const siblingB = buildSequence(['anchor']);
  const oldChapters = ['source', 'anchor'];
  const preorder = buildSequence(['parent-a', 'source', 'parent-b', 'anchor'], new Set(oldChapters));
  const chapters = buildSequence(oldChapters, new Set(oldChapters));
  const original = {
    siblings: new Map([...siblingA.nodes, ...siblingB.nodes]),
    preorder: preorder.nodes,
    chapters: chapters.nodes,
  };
  const selection: HostedVersionDraftMoveSelection = {
    snapshotId: revisionId,
    headRevisionId: revisionId,
    source: {
      snapshotId: revisionId,
      occurrenceId: 'source',
      parentId: 'parent-a',
      kind: 'chapter',
      subtreeSize: 1n,
      subtreeHeight: 0,
      chapterCount: 1n,
    },
    destinationParent: {
      snapshotId: revisionId,
      occurrenceId: 'parent-b',
      parentId: null,
      kind: 'part',
      subtreeSize: 2n,
      subtreeHeight: 1,
      chapterCount: 1n,
    },
    before: {
      snapshotId: revisionId,
      occurrenceId: 'anchor',
      parentId: 'parent-b',
      kind: 'chapter',
      subtreeSize: 1n,
      subtreeHeight: 0,
      chapterCount: 1n,
    },
    sourceAncestors: [
      { snapshotId: revisionId, occurrenceId: 'parent-a', parentId: null, subtreeSize: 2n, chapterCount: 1n },
    ],
    destinationAncestors: [
      { snapshotId: revisionId, occurrenceId: 'parent-b', parentId: null, subtreeSize: 2n, chapterCount: 1n },
    ],
    sourceSiblingRootId: siblingA.rootId,
    destinationSiblingRootId: siblingB.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
  };
  const tx = {} as CommandTransaction;
  const write = {
    catalogueId: 'catalogue-1',
    input,
    revisionId: 'draft-v8',
    transactionId: 'transaction-1',
    recordedAt: '2026-11-13T00:00:00.000Z',
  };
  const stagedWrites: number[] = [];

  for (const commitResult of [true, false]) {
    const indexes = makeIndexes(original);
    const adapter: HostedVersionDraftMoveNativeAdapter<CommandTransaction> = {
      async selectExpectedSnapshot(selectedTx, catalogueId, selectedInput) {
        expect(selectedTx).toBe(tx);
        expect(catalogueId).toBe(write.catalogueId);
        expect(selectedInput).toEqual(input);
        return { selection, indexes };
      },
      async commitMove(selectedTx, committed) {
        expect(selectedTx).toBe(tx);
        expect(committed.plan.result).toBe('moved');
        expect(committed.snapshot).toEqual({ selection, indexes });
        const counts = [
          committed.snapshot.indexes.siblings.nodeWrites.size,
          committed.snapshot.indexes.preorder.nodeWrites.size,
          committed.snapshot.indexes.chapters.nodeWrites.size,
        ];
        expect(counts.every((count) => count > 0)).toBe(true);
        stagedWrites.push(...counts);
        return commitResult;
      },
    };

    if (commitResult) {
      const result = await commitHostedVersionDraftMoveInTransaction(adapter, tx, write);
      expect(result.value).toEqual({ catalogueId: write.catalogueId, revisionId: write.revisionId });
      expect(result.events).toEqual([
        {
          type: 'com.rezics.content.hosted-catalogue.revise.v1',
          subject: write.catalogueId,
          data: result.value,
        },
      ]);
    } else {
      await expect(commitHostedVersionDraftMoveInTransaction(adapter, tx, write)).rejects.toBeInstanceOf(
        RevisionPreconditionError,
      );
    }
  }
  expect(stagedWrites).toHaveLength(6);

  const noOpInput: HostedVersionDraftMoveInput = {
    ...input,
    parentId: 'parent-a',
    beforeOccurrenceId: null,
  };
  const noOpSelection: HostedVersionDraftMoveSelection = {
    ...selection,
    destinationParent: {
      ...selection.destinationParent,
      occurrenceId: 'parent-a',
      subtreeSize: 2n,
      chapterCount: 1n,
    },
    before: null,
    destinationAncestors: selection.sourceAncestors,
    destinationSiblingRootId: selection.sourceSiblingRootId,
  };
  let noOpCommits = 0;
  const noOpAdapter: HostedVersionDraftMoveNativeAdapter<CommandTransaction> = {
    async selectExpectedSnapshot() {
      return { selection: noOpSelection, indexes: makeIndexes(original) };
    },
    async commitMove() {
      noOpCommits += 1;
      return true;
    },
  };
  const noOp = await commitHostedVersionDraftMoveInTransaction(noOpAdapter, tx, { ...write, input: noOpInput });
  expect(noOp.value.revisionId).toBe(revisionId);
  expect(noOp.events).toEqual([]);
  expect(noOpCommits).toBe(0);
});
