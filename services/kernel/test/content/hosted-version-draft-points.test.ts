import { expect, test } from 'bun:test';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import { prepareHostedVersionDraftPointPlan } from '../../src/content/hosted-version-draft-points.ts';
import {
  HostedVersionDraftPointError,
  type HostedVersionDraftPointIndexes,
  type HostedVersionDraftPointOccurrence,
  type HostedVersionDraftPointSelection,
} from '../../src/content/hosted-version-draft-points-model.ts';

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

function indexes(snapshots: Readonly<{ siblings: Snapshot; preorder: Snapshot; chapters: Snapshot }>) {
  return {
    siblings: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.siblings.get(id) ?? null),
    preorder: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.preorder.get(id) ?? null),
    chapters: createVersionedOutlineSequenceReadWriteSet<string>(async (id) => snapshots.chapters.get(id) ?? null),
    readLegacyMaximum: async () => null,
  } satisfies HostedVersionDraftPointIndexes;
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

function point(
  snapshotId: string,
  occurrenceId: string,
  parentId: string | null,
  kind: 'part' | 'chapter',
  subtreeSize: bigint,
  chapterCount: bigint,
  subtreeHeight = 0,
): HostedVersionDraftPointOccurrence {
  return { snapshotId, occurrenceId, parentId, kind, subtreeSize, chapterCount, subtreeHeight };
}

test('inserts anchored parts and chapters and cuts a large unchanged subtree by aggregate ranges', async () => {
  const revisionId = 'draft-v7';
  const largeChildren = Array.from({ length: 12_000 }, (_, index) => `large-child-${index}`);
  const largeChapterIds = largeChildren.filter((_, index) => index % 2 === 0);
  const rootValues = ['opening-chapter', 'large-part', 'container-part', 'closing-chapter'];
  const containerChildren = ['nested-part', 'container-chapter'];
  const nestedChildren = ['nested-old-chapter'];
  const preorderValues = [
    'opening-chapter',
    'large-part',
    ...largeChildren,
    'container-part',
    'nested-part',
    'nested-old-chapter',
    'container-chapter',
    'closing-chapter',
  ];
  const chapterValues = [
    'opening-chapter',
    ...largeChapterIds,
    'nested-old-chapter',
    'container-chapter',
    'closing-chapter',
  ];

  const rootSiblings = buildSequence(rootValues);
  const largeSiblings = buildSequence(largeChildren);
  const containerSiblingSequence = buildSequence(containerChildren);
  const nestedSiblingSequence = buildSequence(nestedChildren);
  const siblingsSnapshot: Snapshot = new Map([
    ...rootSiblings.nodes,
    ...largeSiblings.nodes,
    ...containerSiblingSequence.nodes,
    ...nestedSiblingSequence.nodes,
  ]);
  const preorder = buildSequence(preorderValues, new Set(chapterValues));
  const chapters = buildSequence(chapterValues, new Set(chapterValues));
  const selected = { siblings: siblingsSnapshot, preorder: preorder.nodes, chapters: chapters.nodes };
  const siblingRootByParent = new Map<string | null, string | null>([
    [null, rootSiblings.rootId],
    ['large-part', largeSiblings.rootId],
    ['container-part', containerSiblingSequence.rootId],
    ['nested-part', nestedSiblingSequence.rootId],
  ]);
  const beforeRoots = {
    siblings: materialize(siblingsSnapshot, rootSiblings.rootId),
    nestedSiblings: materialize(siblingsSnapshot, nestedSiblingSequence.rootId),
    preorder: materialize(preorder.nodes, preorder.rootId),
    chapters: materialize(chapters.nodes, chapters.rootId),
  };
  const unrelatedTargets = new Map(chapterValues.map((id) => [id, `target-revision-${id}`]));
  const publicSelection = ['large-part', 'large-child-0', 'container-part', 'nested-part', 'nested-old-chapter'];

  const nestedParent = point(revisionId, 'nested-part', 'container-part', 'part', 2n, 1n, 1);
  const container = point(revisionId, 'container-part', null, 'part', 4n, 2n, 2);
  const nestedBefore = point(revisionId, 'nested-old-chapter', 'nested-part', 'chapter', 1n, 1n);
  const parentPath = [nestedParent, container];

  const nestedChapterIndexes = indexes(selected);
  const nestedChapterPlan = await prepareHostedVersionDraftPointPlan(
    {
      operation: 'insert',
      expectedRevisionId: revisionId,
      occurrenceId: 'nested-new-chapter',
      parentId: 'nested-part',
      beforeOccurrenceId: 'nested-old-chapter',
      title: 'New chapter',
      placement: {
        kind: 'chapter',
        target: {
          threadId: 'thread-new',
          postId: 'post-new',
          revisionId: 'target-new',
          sha256: 'a'.repeat(64),
        },
      },
    },
    {
      operation: 'insert',
      snapshotId: revisionId,
      headRevisionId: revisionId,
      siblingRootByParent,
      siblingRootId: nestedSiblingSequence.rootId,
      preorderRootId: preorder.rootId,
      chapterRootId: chapters.rootId,
      parentPath,
      before: nestedBefore,
      occurrenceIdentityExists: false,
    },
    nestedChapterIndexes,
  );
  expect(nestedChapterPlan.ancestorDeltas).toEqual([
    {
      occurrenceId: 'nested-part',
      subtreeSizeDelta: 1n,
      chapterCountDelta: 1n,
      subtreeSize: 3n,
      chapterCount: 2n,
    },
    {
      occurrenceId: 'container-part',
      subtreeSizeDelta: 1n,
      chapterCountDelta: 1n,
      subtreeSize: 5n,
      chapterCount: 3n,
    },
  ]);
  expect(materialize(commit(preorder.nodes, nestedChapterIndexes.preorder), nestedChapterPlan.preorderRootId)).toEqual(
    beforeRoots.preorder.toSpliced(beforeRoots.preorder.indexOf('nested-old-chapter'), 0, 'nested-new-chapter'),
  );
  expect(materialize(commit(chapters.nodes, nestedChapterIndexes.chapters), nestedChapterPlan.chapterRootId)).toEqual(
    beforeRoots.chapters.toSpliced(beforeRoots.chapters.indexOf('nested-old-chapter'), 0, 'nested-new-chapter'),
  );

  const nestedPartIndexes = indexes(selected);
  const nestedPartPlan = await prepareHostedVersionDraftPointPlan(
    {
      operation: 'insert',
      expectedRevisionId: revisionId,
      occurrenceId: 'nested-empty-part',
      parentId: 'nested-part',
      beforeOccurrenceId: 'nested-old-chapter',
      title: 'Empty part',
      placement: { kind: 'part' },
    },
    {
      operation: 'insert',
      snapshotId: revisionId,
      headRevisionId: revisionId,
      siblingRootByParent,
      siblingRootId: nestedSiblingSequence.rootId,
      preorderRootId: preorder.rootId,
      chapterRootId: chapters.rootId,
      parentPath,
      before: nestedBefore,
      occurrenceIdentityExists: false,
    },
    nestedPartIndexes,
  );
  expect(nestedPartPlan.chapterRootId).toBe(chapters.rootId);
  expect(
    nestedPartPlan.ancestorDeltas.map(({ occurrenceId, subtreeSize, chapterCount }) => [
      occurrenceId,
      subtreeSize,
      chapterCount,
    ]),
  ).toEqual([
    ['nested-part', 3n, 1n],
    ['container-part', 5n, 2n],
  ]);
  expect(materialize(commit(siblingsSnapshot, nestedPartIndexes.siblings), nestedPartPlan.siblingRootId)).toEqual([
    'nested-empty-part',
    'nested-old-chapter',
  ]);

  const rootInsertIndexes = indexes(selected);
  const rootInsertPlan = await prepareHostedVersionDraftPointPlan(
    {
      operation: 'insert',
      expectedRevisionId: revisionId,
      occurrenceId: 'new-root-part',
      parentId: null,
      beforeOccurrenceId: 'container-part',
      title: 'New root part',
      placement: { kind: 'part' },
    },
    {
      operation: 'insert',
      snapshotId: revisionId,
      headRevisionId: revisionId,
      siblingRootByParent,
      siblingRootId: rootSiblings.rootId,
      preorderRootId: preorder.rootId,
      chapterRootId: chapters.rootId,
      parentPath: [],
      before: point(revisionId, 'container-part', null, 'part', 4n, 2n, 2),
      occurrenceIdentityExists: false,
    },
    rootInsertIndexes,
  );
  expect(materialize(commit(preorder.nodes, rootInsertIndexes.preorder), rootInsertPlan.preorderRootId)).toEqual(
    beforeRoots.preorder.toSpliced(beforeRoots.preorder.indexOf('container-part'), 0, 'new-root-part'),
  );

  const removalIndexes = indexes(selected);
  const removalPlan = await prepareHostedVersionDraftPointPlan(
    { operation: 'remove', expectedRevisionId: revisionId, occurrenceId: 'large-part' },
    {
      operation: 'remove',
      snapshotId: revisionId,
      headRevisionId: revisionId,
      siblingRootByParent,
      siblingRootId: rootSiblings.rootId,
      preorderRootId: preorder.rootId,
      chapterRootId: chapters.rootId,
      source: point(revisionId, 'large-part', null, 'part', 12_001n, 6_000n, 1),
      sourceAncestors: [],
    },
    removalIndexes,
  );
  expect(removalPlan.preorderCount).toBe(12_001n);
  expect(removalPlan.chapterCount).toBe(6_000n);
  expect(materialize(commit(siblingsSnapshot, removalIndexes.siblings), removalPlan.siblingRootId)).toEqual([
    'opening-chapter',
    'container-part',
    'closing-chapter',
  ]);
  expect(materialize(commit(preorder.nodes, removalIndexes.preorder), removalPlan.preorderRootId)).toEqual([
    'opening-chapter',
    'container-part',
    'nested-part',
    'nested-old-chapter',
    'container-chapter',
    'closing-chapter',
  ]);
  expect(materialize(commit(chapters.nodes, removalIndexes.chapters), removalPlan.chapterRootId)).toEqual([
    'opening-chapter',
    'nested-old-chapter',
    'container-chapter',
    'closing-chapter',
  ]);

  const height = preorder.nodes.get(preorder.rootId!)!.height + chapters.nodes.get(chapters.rootId!)!.height + 8;
  const visited =
    removalPlan.work.siblings.snapshotProbeCount +
    removalPlan.work.preorder.snapshotProbeCount +
    removalPlan.work.chapters.snapshotProbeCount;
  const written =
    removalPlan.work.siblings.writtenNodeCount +
    removalPlan.work.preorder.writtenNodeCount +
    removalPlan.work.chapters.writtenNodeCount;
  expect(visited + written).toBeLessThan(64 * height);
  expect(visited + written).toBeLessThan(Number(removalPlan.preorderCount));
  expect(materialize(siblingsSnapshot, rootSiblings.rootId)).toEqual(beforeRoots.siblings);
  expect(materialize(siblingsSnapshot, nestedSiblingSequence.rootId)).toEqual(beforeRoots.nestedSiblings);
  expect(materialize(preorder.nodes, preorder.rootId)).toEqual(beforeRoots.preorder);
  expect(materialize(chapters.nodes, chapters.rootId)).toEqual(beforeRoots.chapters);
  expect([...unrelatedTargets]).toEqual(chapterValues.map((id) => [id, `target-revision-${id}`]));
  expect(publicSelection).toEqual([
    'large-part',
    'large-child-0',
    'container-part',
    'nested-part',
    'nested-old-chapter',
  ]);

  const staleIndexes = indexes(selected);
  await expect(
    prepareHostedVersionDraftPointPlan(
      { operation: 'remove', expectedRevisionId: 'draft-v6', occurrenceId: 'large-part' },
      {
        operation: 'remove',
        snapshotId: revisionId,
        headRevisionId: revisionId,
        siblingRootByParent,
        siblingRootId: rootSiblings.rootId,
        preorderRootId: preorder.rootId,
        chapterRootId: chapters.rootId,
        source: point(revisionId, 'large-part', null, 'part', 12_001n, 6_000n, 1),
        sourceAncestors: [],
      },
      staleIndexes,
    ),
  ).rejects.toMatchObject({ code: 'stale-head' } satisfies Partial<HostedVersionDraftPointError>);

  const reusedIdIndexes = indexes(selected);
  const insertInput = {
    operation: 'insert' as const,
    expectedRevisionId: revisionId,
    occurrenceId: 'nested-old-chapter',
    parentId: 'nested-part',
    beforeOccurrenceId: null,
    title: 'Reused handle',
    placement: { kind: 'part' as const },
  };
  const reusedIdSelection: HostedVersionDraftPointSelection = {
    operation: 'insert',
    snapshotId: revisionId,
    headRevisionId: revisionId,
    siblingRootByParent,
    siblingRootId: nestedSiblingSequence.rootId,
    preorderRootId: preorder.rootId,
    chapterRootId: chapters.rootId,
    parentPath,
    before: null,
    occurrenceIdentityExists: true,
  };
  await expect(
    prepareHostedVersionDraftPointPlan(insertInput, reusedIdSelection, reusedIdIndexes),
  ).rejects.toMatchObject({ code: 'invalid-anchor' });
});
