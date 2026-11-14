import { expect, test } from 'bun:test';
import type { CommandTransaction } from '../../src/command/command.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import { commitHostedVersionDraftMoveInTransaction } from '../../src/content/hosted-version-draft-edit-command.ts';
import { prepareHostedVersionDraftMovePlan } from '../../src/content/hosted-version-draft-edit.ts';
import {
  type HostedVersionDraftMoveInput,
  type HostedVersionDraftMoveNativeAdapter,
  type HostedVersionDraftMoveIndexes,
  type HostedVersionDraftMoveSelection,
} from '../../src/content/hosted-version-draft-edit-model.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import { createHostedVersionDraftMoveNativeAdapter } from '../../src/content/hosted-version-draft-native.ts';
import type { HostedVersionDraftMoveSelectedOccurrence } from '../../src/content/hosted-version-draft-native-model.ts';
import draftHeadSql from '../../src/content/hosted-version-draft-native-read-head.sql';
import snapshotSql from '../../src/content/hosted-version-read-snapshot.sql';
import versionHeadSql from '../../src/content/hosted-version-read-head.sql';
import nodeSql from '../../src/content/hosted-version-read-node.sql';
import nodesSql from '../../src/content/hosted-version-read-nodes.sql';
import occurrencesSql from '../../src/content/hosted-version-read-occurrences.sql';
import siblingRootsSql from '../../src/content/hosted-version-read-sibling-roots.sql';

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
    const maximum = [
      { subtreeHeight: 0, occurrenceId: id },
      ...(left === null
        ? []
        : [{ subtreeHeight: left.maximumSubtreeHeight!, occurrenceId: left.maximumSubtreeOccurrenceId! }]),
      ...(right === null
        ? []
        : [{ subtreeHeight: right.maximumSubtreeHeight!, occurrenceId: right.maximumSubtreeOccurrenceId! }]),
    ].reduce((best, candidate) =>
      candidate.subtreeHeight > best.subtreeHeight ||
      (candidate.subtreeHeight === best.subtreeHeight && candidate.occurrenceId < best.occurrenceId)
        ? candidate
        : best,
    );
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
      subtreeHeight: 0,
      maximumSubtreeHeight: maximum.subtreeHeight,
      maximumSubtreeOccurrenceId: maximum.occurrenceId,
    });
    return id;
  }
  return { nodes, rootId: build(0, values.length, null) };
}

function makeIndexes(
  snapshots: Readonly<{ siblings: Snapshot; preorder: Snapshot; chapters: Snapshot }>,
  batches?: { index: 'siblings' | 'preorder' | 'chapters'; ids: readonly string[] }[],
) {
  const access = (index: 'siblings' | 'preorder' | 'chapters') =>
    createVersionedOutlineSequenceReadWriteSet<string>(
      async (id) => snapshots[index].get(id) ?? null,
      async (ids) => {
        batches?.push({ index, ids: [...ids] });
        return new Map(ids.map((id) => [id, snapshots[index].get(id) ?? null]));
      },
    );
  const accesses = {
    siblings: access('siblings'),
    preorder: access('preorder'),
    chapters: access('chapters'),
    readLegacyMaximum: async () => null,
  } satisfies HostedVersionDraftMoveIndexes;
  return accesses;
}

function commit(snapshot: Snapshot, access: VersionedOutlineSequenceReadWriteSet<string>): Snapshot {
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
  const rootSiblings = buildSequence(['parent-a', 'parent-b', 'outside-tail'], new Set(['outside-tail']));
  const sourceSiblings = buildSequence(descendantIds, new Set(sourceChapterIds));
  const preorder = buildSequence(oldPreorder, new Set(oldChapters));
  const chapters = buildSequence(oldChapters, new Set(oldChapters));
  const siblingSnapshot = new Map([
    ...rootSiblings.nodes,
    ...siblingA.nodes,
    ...siblingB.nodes,
    ...sourceSiblings.nodes,
  ]);
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
      {
        snapshotId: revisionId,
        occurrenceId: 'parent-a',
        parentId: null,
        subtreeSize: 12_004n,
        chapterCount: 6_002n,
        subtreeHeight: 2,
      },
    ],
    destinationAncestors: [
      {
        snapshotId: revisionId,
        occurrenceId: 'parent-b',
        parentId: null,
        subtreeSize: 3n,
        chapterCount: 2n,
        subtreeHeight: 1,
      },
    ],
    sourceSiblingRootId: siblingA.rootId,
    destinationSiblingRootId: siblingB.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
    siblingRootByParent: new Map([
      [null, rootSiblings.rootId],
      ['parent-a', siblingA.rootId],
      ['parent-b', siblingB.rootId],
      ['source-part', sourceSiblings.rootId],
    ]),
  };
  const input: HostedVersionDraftMoveInput = {
    expectedRevisionId: revisionId,
    occurrenceId: 'source-part',
    parentId: 'parent-b',
    beforeOccurrenceId: 'b-before',
  };
  const batches: { index: 'siblings' | 'preorder' | 'chapters'; ids: readonly string[] }[] = [];
  const indexes = makeIndexes(original, batches);
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
  expect(batches.some((batch) => batch.index === 'preorder' && batch.ids.length > 2)).toBe(true);
  expect(batches.every((batch) => batch.ids.length <= 512)).toBe(true);
  for (const index of ['siblings', 'preorder', 'chapters'] as const) {
    const ids = batches.filter((batch) => batch.index === index).flatMap((batch) => batch.ids);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(indexes[index].work().snapshotProbeCount).toBe(ids.length);
  }

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

  const wrongPlacement = new Map(original.preorder);
  wrongPlacement.set('source-part', { ...wrongPlacement.get('source-part')!, value: 'another-occurrence' });
  await expect(
    prepareHostedVersionDraftMovePlan(input, selection, makeIndexes({ ...original, preorder: wrongPlacement })),
  ).rejects.toMatchObject({ code: 'invalid-anchor' });

  const noopIndexes = makeIndexes(original);
  const noOp = await prepareHostedVersionDraftMovePlan(
    { ...input, parentId: 'parent-a', beforeOccurrenceId: 'a-after' },
    {
      ...selection,
      destinationParent: { ...selection.destinationParent!, occurrenceId: 'parent-a', subtreeSize: 12_004n },
      before: { ...selection.before!, occurrenceId: 'a-after', parentId: 'parent-a' },
      destinationAncestors: selection.sourceAncestors,
      destinationSiblingRootId: selection.sourceSiblingRootId,
    },
    noopIndexes,
  );
  expect(noOp.result).toBe('no-op');
  expect(noOp.work.siblings.writtenNodeCount + noOp.work.preorder.writtenNodeCount).toBe(0);
});

test('promotes a large subtree to the root, reorders root siblings, and skips an adjacent root move', async () => {
  const revisionId = 'draft-root-v1';
  const descendants = Array.from({ length: 12_000 }, (_, index) => `root-child-${index}`);
  const oldPreorder = ['source-parent', 'source-part', ...descendants, 'root-anchor'];
  const oldChapters = [...descendants, 'root-anchor'];
  const rootSiblings = buildSequence(['source-parent', 'root-anchor']);
  const parentSiblings = buildSequence(['source-part']);
  const sourceSiblings = buildSequence(descendants);
  const preorder = buildSequence(oldPreorder, new Set(oldChapters));
  const chapters = buildSequence(oldChapters, new Set(oldChapters));
  const original = {
    siblings: new Map([...rootSiblings.nodes, ...parentSiblings.nodes, ...sourceSiblings.nodes]),
    preorder: preorder.nodes,
    chapters: chapters.nodes,
  };
  const sourceSize = BigInt(descendants.length + 1);
  const selection: HostedVersionDraftMoveSelection = {
    snapshotId: revisionId,
    headRevisionId: revisionId,
    source: {
      snapshotId: revisionId,
      occurrenceId: 'source-part',
      parentId: 'source-parent',
      kind: 'part',
      subtreeSize: sourceSize,
      subtreeHeight: 1,
      chapterCount: BigInt(descendants.length),
    },
    destinationParent: null,
    before: null,
    sourceAncestors: [
      {
        snapshotId: revisionId,
        occurrenceId: 'source-parent',
        parentId: null,
        subtreeSize: sourceSize + 1n,
        chapterCount: BigInt(descendants.length),
        subtreeHeight: 2,
      },
    ],
    destinationAncestors: [],
    sourceSiblingRootId: parentSiblings.rootId,
    destinationSiblingRootId: rootSiblings.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
    siblingRootByParent: new Map([
      [null, rootSiblings.rootId],
      ['source-parent', parentSiblings.rootId],
      ['source-part', sourceSiblings.rootId],
    ]),
  };
  const input: HostedVersionDraftMoveInput = {
    expectedRevisionId: revisionId,
    occurrenceId: 'source-part',
    parentId: null,
    beforeOccurrenceId: null,
  };
  const indexes = makeIndexes(original);
  const promoted = await prepareHostedVersionDraftMovePlan(input, selection, indexes);
  const promotedSnapshots = {
    siblings: commit(original.siblings, indexes.siblings),
    preorder: commit(original.preorder, indexes.preorder),
    chapters: commit(original.chapters, indexes.chapters),
  };

  expect(promoted.result).toBe('moved');
  expect(promoted.toParentId).toBeNull();
  expect(promoted.ancestorDeltas).toEqual([
    {
      occurrenceId: 'source-parent',
      subtreeSizeDelta: -sourceSize,
      chapterCountDelta: -BigInt(descendants.length),
      subtreeSize: 1n,
      chapterCount: 0n,
    },
  ]);
  expect(materialize(promotedSnapshots.siblings, promoted.destinationSiblingRootId)).toEqual([
    'source-parent',
    'root-anchor',
    'source-part',
  ]);
  expect(materialize(promotedSnapshots.siblings, promoted.sourceSiblingRootId)).toEqual([]);
  expect(materialize(promotedSnapshots.preorder, promoted.preorderRootId)).toEqual([
    'source-parent',
    'root-anchor',
    'source-part',
    ...descendants,
  ]);
  expect(materialize(promotedSnapshots.chapters, promoted.chapterRootId)).toEqual(['root-anchor', ...descendants]);
  expect(materialize(original.preorder, preorder.rootId)).toEqual(oldPreorder);
  expect(materialize(original.chapters, chapters.rootId)).toEqual(oldChapters);

  const pathBound =
    64 * (preorder.nodes.get(preorder.rootId!)!.height + chapters.nodes.get(chapters.rootId!)!.height + 8);
  const promotedWork =
    promoted.work.siblings.snapshotProbeCount +
    promoted.work.preorder.snapshotProbeCount +
    promoted.work.chapters.snapshotProbeCount;
  const promotedWrites =
    promoted.work.siblings.writtenNodeCount +
    promoted.work.preorder.writtenNodeCount +
    promoted.work.chapters.writtenNodeCount;
  expect(promotedWork).toBeLessThan(pathBound);
  expect(promotedWrites).toBeLessThan(pathBound);
  expect(promotedWork).toBeLessThan(descendants.length);
  expect(promotedWrites).toBeLessThan(descendants.length);

  const reorderIndexes = makeIndexes(promotedSnapshots);
  const rootSelection: HostedVersionDraftMoveSelection = {
    ...selection,
    source: { ...selection.source, parentId: null },
    destinationParent: null,
    before: {
      snapshotId: revisionId,
      occurrenceId: 'root-anchor',
      parentId: null,
      kind: 'chapter',
      subtreeSize: 1n,
      subtreeHeight: 0,
      chapterCount: 1n,
    },
    sourceAncestors: [],
    destinationAncestors: [],
    sourceSiblingRootId: promoted.destinationSiblingRootId,
    destinationSiblingRootId: promoted.destinationSiblingRootId,
    preorderRootId: promoted.preorderRootId,
    chapterRootId: promoted.chapterRootId,
  };
  const reordered = await prepareHostedVersionDraftMovePlan(
    { ...input, beforeOccurrenceId: 'root-anchor' },
    rootSelection,
    reorderIndexes,
  );
  expect(reordered.result).toBe('moved');
  expect(reordered.ancestorDeltas).toEqual([]);
  expect(
    materialize(commit(promotedSnapshots.siblings, reorderIndexes.siblings), reordered.destinationSiblingRootId),
  ).toEqual(['source-parent', 'source-part', 'root-anchor']);
  expect(materialize(commit(promotedSnapshots.preorder, reorderIndexes.preorder), reordered.preorderRootId)).toEqual([
    'source-parent',
    'source-part',
    ...descendants,
    'root-anchor',
  ]);

  const reorderedSnapshots = {
    siblings: commit(promotedSnapshots.siblings, reorderIndexes.siblings),
    preorder: commit(promotedSnapshots.preorder, reorderIndexes.preorder),
    chapters: commit(promotedSnapshots.chapters, reorderIndexes.chapters),
  };
  const adjacentIndexes = makeIndexes(reorderedSnapshots);
  const adjacentSelection: HostedVersionDraftMoveSelection = {
    ...rootSelection,
    sourceSiblingRootId: reordered.destinationSiblingRootId,
    destinationSiblingRootId: reordered.destinationSiblingRootId,
    preorderRootId: reordered.preorderRootId,
    chapterRootId: reordered.chapterRootId,
  };
  const adjacent = await prepareHostedVersionDraftMovePlan(
    { ...input, beforeOccurrenceId: 'root-anchor' },
    adjacentSelection,
    adjacentIndexes,
  );
  expect(adjacent.result).toBe('no-op');
  expect(adjacent.work.siblings.writtenNodeCount + adjacent.work.preorder.writtenNodeCount).toBe(0);
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
  const rootSiblings = buildSequence(['parent-a', 'parent-b']);
  const oldChapters = ['source', 'anchor'];
  const preorder = buildSequence(['parent-a', 'source', 'parent-b', 'anchor'], new Set(oldChapters));
  const chapters = buildSequence(oldChapters, new Set(oldChapters));
  const original = {
    siblings: new Map([...rootSiblings.nodes, ...siblingA.nodes, ...siblingB.nodes]),
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
      {
        snapshotId: revisionId,
        occurrenceId: 'parent-a',
        parentId: null,
        subtreeSize: 2n,
        chapterCount: 1n,
        subtreeHeight: 1,
      },
    ],
    destinationAncestors: [
      {
        snapshotId: revisionId,
        occurrenceId: 'parent-b',
        parentId: null,
        subtreeSize: 2n,
        chapterCount: 1n,
        subtreeHeight: 1,
      },
    ],
    sourceSiblingRootId: siblingA.rootId,
    destinationSiblingRootId: siblingB.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
    siblingRootByParent: new Map([
      [null, rootSiblings.rootId],
      ['parent-a', siblingA.rootId],
      ['parent-b', siblingB.rootId],
    ]),
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
      ...selection.destinationParent!,
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

function encodePreflightValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { kind: 'bigint', value: value.toString() };
  if (Array.isArray(value)) return { kind: 'array', value: value.map(encodePreflightValue) };
  if (value !== null && typeof value === 'object') {
    return { kind: 'object', value: Object.entries(value).map(([key, item]) => [key, encodePreflightValue(item)]) };
  }
  return { kind: 'primitive', value };
}

function nativePreflightFixture() {
  const id = (index: number) => `00000000-0000-7000-8000-0001${index.toString(16).padStart(8, '0')}`;
  const [catalogueId, generationId, revisionId, outer, parentA, source, parentB, empty, anchor, tail] = Array.from(
    { length: 10 },
    (_, index) => id(index + 1),
  ) as [string, string, string, string, string, string, string, string, string, string];
  const descendants = Array.from({ length: 6000 }, (_, index) => id(index + 100));
  const weighted = new Set([...descendants.filter((_, index) => index % 2 === 1), anchor, tail]);
  const preorder = buildSequence([outer, parentA, source, ...descendants, parentB, empty, anchor, tail], weighted);
  const chapters = buildSequence(
    materialize(preorder.nodes, preorder.rootId).filter((nodeId) => weighted.has(nodeId)),
    weighted,
  );
  const facts = new Map<string, HostedVersionDraftMoveSelectedOccurrence>();
  for (const [occurrenceId, parentOccurrenceId, subtreeSize, chapterCount, subtreeHeight] of [
    [outer, null, 6007n, 3001n, 3],
    [parentA, outer, 6002n, 3000n, 2],
    [source, parentA, 6001n, 3000n, 1],
    [parentB, outer, 3n, 1n, 1],
    [empty, parentB, 1n, 0n, 0],
    [anchor, parentB, 1n, 1n, 0],
    [tail, null, 1n, 1n, 0],
  ] as const) {
    facts.set(occurrenceId, {
      occurrenceId,
      parentOccurrenceId,
      subtreeSize,
      sequence: 7n,
      value: {
        kind: weighted.has(occurrenceId) ? 'chapter' : 'part',
        chapterCount,
        subtreeHeight,
        title: null,
        target: null,
      },
    });
  }
  const snapshotRow = {
    route: 1,
    catalogue_id: catalogueId,
    generation_id: generationId,
    generation_kind: 'draft',
    sequence: '7',
    preorder_root_id: preorder.rootId,
    chapter_root_id: chapters.rootId,
    placement_count: '6008',
    chapter_count: '3002',
  };
  const descriptor = {
    kind: 'ordered',
    revisionKind: 'structure',
    revisionId,
    sourceRevisionId: null,
    snapshot: { route: 1, catalogueId, generationId, generationKind: 'draft', sequence: 7n },
  } as const;
  const batches: { index: string; ids: readonly string[] }[] = [];
  const occurrenceBatches: string[][] = [];
  const siblingRootBatches: (string | null)[][] = [];
  const siblingRoots = [
    { parent_id: null, root_node_id: 'root-from-sequence-5', sequence: '5' },
    { parent_id: parentA, root_node_id: 'parent-a-siblings', sequence: '7' },
    { parent_id: parentB, root_node_id: null, sequence: '7' },
    { parent_id: empty, root_node_id: null, sequence: '6' },
  ];
  const tx = {
    async query(sql: string, args: readonly unknown[]) {
      if (sql === draftHeadSql.sql) return { rows: [{ head_revision_id: revisionId }] };
      if (sql === snapshotSql.sql || sql === versionHeadSql.sql) return { rows: [snapshotRow] };
      if (sql === occurrencesSql.sql) {
        expect(args[4]).toBe('7');
        const ids = args[3] as string[];
        occurrenceBatches.push([...ids]);
        return {
          rows: ids.map((nodeId) => {
            const fact = facts.get(nodeId)!;
            return {
              occurrence_id: nodeId,
              parent_occurrence_id: fact.parentOccurrenceId,
              subtree_size: fact.subtreeSize.toString(),
              occurrence_state: encodePreflightValue(fact.value),
              subtree_height: fact.value.subtreeHeight,
              sequence: '7',
              is_deleted: false,
            };
          }),
        };
      }
      if (sql === nodeSql.sql || sql === nodesSql.sql) {
        expect(args[5]).toBe('7');
        const index = args[3] as string;
        const ids = sql === nodeSql.sql ? [args[4] as string] : (args[4] as string[]);
        batches.push({ index, ids: [...ids] });
        const nodes = index === 'preorder' ? preorder.nodes : chapters.nodes;
        return {
          rows: ids.map((nodeId) => {
            const node = nodes.get(nodeId)!;
            return {
              node_id: nodeId,
              tree_parent_id: node.treeParentId,
              node_state: encodePreflightValue(node),
              sequence: '7',
              is_deleted: false,
            };
          }),
        };
      }
      if (sql === siblingRootsSql.sql) {
        expect(args[5]).toBe('7');
        const ids = args[3] as (string | null)[];
        siblingRootBatches.push([...ids]);
        return { rows: siblingRoots.filter(({ parent_id }) => ids.includes(parent_id)) };
      }
      throw new Error('Unexpected preflight SQL');
    },
  } as unknown as CommandTransaction;
  const input: HostedVersionDraftMoveInput = {
    expectedRevisionId: revisionId,
    occurrenceId: source,
    parentId: parentB,
    beforeOccurrenceId: empty,
  };
  const select = (selectedInput = input) =>
    createHostedVersionDraftMoveNativeAdapter().selectExpectedSnapshot(tx, catalogueId, selectedInput, descriptor);
  return {
    select,
    input,
    facts,
    batches,
    occurrenceBatches,
    siblingRootBatches,
    outer,
    parentA,
    source,
    parentB,
    empty,
    tail,
    preorder,
  };
}

test('native preflight shares large-Book participant and ancestor frontiers, including empty and root placements', async () => {
  const fixture = nativePreflightFixture();
  const { selection, indexes } = await fixture.select();
  expect(selection.source.chapterCount).toBe(3000n);
  expect(selection.before?.chapterCount).toBe(0n);
  expect(selection.sourceAncestors.map(({ occurrenceId }) => occurrenceId)).toEqual([fixture.parentA, fixture.outer]);
  expect(selection.destinationAncestors.map(({ occurrenceId }) => occurrenceId)).toEqual([fixture.outer]);
  expect(fixture.siblingRootBatches).toEqual([
    [null, fixture.source, fixture.parentA, fixture.parentB, fixture.empty, fixture.outer],
  ]);
  expect(fixture.siblingRootBatches.every(({ length }) => length <= 512)).toBe(true);
  expect(selection.sourceSiblingRootId).toBe('parent-a-siblings');
  expect(selection.destinationSiblingRootId).toBeNull();
  expect(selection.siblingRootByParent.get(null)).toBe('root-from-sequence-5');
  expect(selection.siblingRootByParent.get(fixture.empty)).toBeNull();
  expect(selection.siblingRootByParent.has(fixture.source)).toBe(true);
  expect(selection.siblingRootByParent.get(fixture.source)).toBeNull();
  const participants = [fixture.source, fixture.parentB, fixture.empty, fixture.parentA, fixture.outer];
  const preorderBatches = fixture.batches.filter(({ index }) => index === 'preorder');
  expect(preorderBatches.some(({ ids }) => participants.every((id) => ids.includes(id)))).toBe(true);
  expect(fixture.occurrenceBatches.flat()).toHaveLength(participants.length);
  expect(fixture.batches.every(({ ids }) => ids.length <= 512)).toBe(true);
  for (const index of ['preorder', 'chapter']) {
    const ids = fixture.batches.filter((batch) => batch.index === index).flatMap((batch) => batch.ids);
    expect(ids).toHaveLength(new Set(ids).size);
  }
  const height = fixture.preorder.nodes.get(fixture.preorder.rootId!)!.height;
  expect(indexes.preorder.work().snapshotProbeCount).toBeLessThan(32 * height);
  expect(preorderBatches.length).toBeLessThan(4 * height);
  expect(indexes.preorder.nodeWrites.size).toBe(0);
  const root = await fixture.select({ ...fixture.input, parentId: null, beforeOccurrenceId: fixture.tail });
  expect(root.selection.destinationParent).toBeNull();
  expect(root.selection.destinationAncestors).toEqual([]);
  expect(root.selection.destinationSiblingRootId).toBe('root-from-sequence-5');
  const sameParent = await fixture.select({ ...fixture.input, parentId: fixture.parentA, beforeOccurrenceId: null });
  expect(sameParent.selection.sourceSiblingRootId).toBe(sameParent.selection.destinationSiblingRootId);
  const empty = await fixture.select({ ...fixture.input, occurrenceId: fixture.empty, beforeOccurrenceId: null });
  expect(empty.selection.source.chapterCount).toBe(0n);

  for (const id of participants) {
    const fact = fixture.facts.get(id)!;
    fixture.facts.set(id, { ...fact, value: { ...fact.value, chapterCount: fact.value.chapterCount + 1n } });
    await expect(fixture.select()).rejects.toThrow('chapter summary does not match its selected preorder');
    fixture.facts.set(id, fact);
  }
});
