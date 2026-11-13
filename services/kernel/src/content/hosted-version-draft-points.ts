import {
  chapterRankVersionedOutlineSequenceNode,
  insertVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
  selectVersionedOutlineSequenceNode,
  spliceVersionedOutlineSequence,
} from './versioned-outline-sequence.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-limits.ts';
import {
  HostedVersionDraftPointError,
  type HostedVersionDraftPointAncestor,
  type HostedVersionDraftPointAncestorDelta,
  type HostedVersionDraftPointIndexes,
  type HostedVersionDraftPointInput,
  type HostedVersionDraftPointOccurrence,
  type HostedVersionDraftPointPlan,
  type HostedVersionDraftPointSelection,
} from './hosted-version-draft-points-model.ts';

function invalidAnchor(): never {
  throw new HostedVersionDraftPointError('invalid-anchor');
}

function assertSnapshot(selection: HostedVersionDraftPointSelection, expectedRevisionId: string): void {
  if (selection.headRevisionId !== expectedRevisionId || selection.snapshotId !== expectedRevisionId) {
    throw new HostedVersionDraftPointError('stale-head');
  }
}

function assertFactsInSnapshot(
  selection: HostedVersionDraftPointSelection,
  facts: readonly (HostedVersionDraftPointOccurrence | HostedVersionDraftPointAncestor | null)[],
): void {
  if (facts.some((fact) => fact !== null && fact.snapshotId !== selection.snapshotId)) invalidAnchor();
}

function assertAncestorChain(
  parentId: string | null,
  ancestors: readonly (HostedVersionDraftPointAncestor | HostedVersionDraftPointOccurrence)[],
): void {
  if (ancestors.length > HOSTED_DEPTH_LIMIT || (ancestors[0]?.occurrenceId ?? null) !== parentId) invalidAnchor();
  const visited = new Set<string>();
  for (let index = 0; index < ancestors.length; index += 1) {
    const ancestor = ancestors[index]!;
    if (visited.has(ancestor.occurrenceId)) invalidAnchor();
    visited.add(ancestor.occurrenceId);
    if (ancestor.parentId !== (ancestors[index + 1]?.occurrenceId ?? null)) invalidAnchor();
  }
}

async function sequenceLength(
  indexes: HostedVersionDraftPointIndexes,
  which: 'siblings' | 'preorder' | 'chapters',
  rootId: string | null,
): Promise<bigint> {
  if (rootId === null) return 0n;
  const root = await indexes[which].readNode(rootId);
  if (root === null || root.treeParentId !== null) throw new Error('Hosted draft point sequence root is not selected');
  return root.count;
}

async function selectedRank(
  access: HostedVersionDraftPointIndexes['siblings'] | HostedVersionDraftPointIndexes['preorder'],
  rootId: string | null,
  occurrenceId: string,
): Promise<bigint> {
  const rank = await rankVersionedOutlineSequenceNode(access, rootId, occurrenceId);
  if (rank === null) invalidAnchor();
  const selected = await selectVersionedOutlineSequenceNode(access, rootId, rank);
  if (selected?.value !== occurrenceId) invalidAnchor();
  return rank;
}

async function selectedPreorderRank(
  indexes: HostedVersionDraftPointIndexes,
  rootId: string | null,
  occurrenceId: string,
): Promise<bigint> {
  return selectedRank(indexes.preorder, rootId, occurrenceId);
}

async function insertionChapterRank(
  input: Extract<HostedVersionDraftPointInput, { operation: 'insert' }>,
  selection: Extract<HostedVersionDraftPointSelection, { operation: 'insert' }>,
  indexes: HostedVersionDraftPointIndexes,
): Promise<bigint> {
  if (selection.before !== null) {
    return chapterRankVersionedOutlineSequenceNode(
      indexes.preorder,
      selection.preorderRootId,
      selection.before.occurrenceId,
    ).then((rank) => {
      if (rank === null) invalidAnchor();
      return rank;
    });
  }

  const parent = selection.parentPath[0] ?? null;
  if (parent === null) return sequenceLength(indexes, 'chapters', selection.chapterRootId);
  const parentRank = await chapterRankVersionedOutlineSequenceNode(
    indexes.preorder,
    selection.preorderRootId,
    parent.occurrenceId,
  );
  if (parentRank === null) invalidAnchor();
  return parentRank + parent.chapterCount;
}

function ancestorDeltas(
  ancestors: readonly HostedVersionDraftPointAncestor[],
  subtreeSizeDelta: bigint,
  chapterCountDelta: bigint,
): readonly HostedVersionDraftPointAncestorDelta[] {
  const seen = new Set<string>();
  return ancestors.map((ancestor) => {
    if (seen.has(ancestor.occurrenceId)) invalidAnchor();
    seen.add(ancestor.occurrenceId);
    const subtreeSize = ancestor.subtreeSize + subtreeSizeDelta;
    const chapterCount = ancestor.chapterCount + chapterCountDelta;
    if (subtreeSize < 1n || chapterCount < 0n) {
      throw new Error('Hosted version draft point produced a negative ancestor summary');
    }
    return {
      occurrenceId: ancestor.occurrenceId,
      subtreeSizeDelta,
      chapterCountDelta,
      subtreeSize,
      chapterCount,
    };
  });
}

function ancestorFacts(ancestors: readonly HostedVersionDraftPointOccurrence[]): HostedVersionDraftPointAncestor[] {
  return ancestors.map(({ snapshotId, occurrenceId, parentId, subtreeSize, chapterCount }) => ({
    snapshotId,
    occurrenceId,
    parentId,
    subtreeSize,
    chapterCount,
  }));
}

async function prepareInsert(
  input: Extract<HostedVersionDraftPointInput, { operation: 'insert' }>,
  selection: Extract<HostedVersionDraftPointSelection, { operation: 'insert' }>,
  indexes: HostedVersionDraftPointIndexes,
): Promise<HostedVersionDraftPointPlan> {
  assertFactsInSnapshot(selection, [...selection.parentPath, selection.before]);
  assertAncestorChain(input.parentId, selection.parentPath);
  const parent = selection.parentPath[0] ?? null;
  if (
    (parent?.occurrenceId ?? null) !== input.parentId ||
    (parent !== null &&
      (parent.kind !== 'part' || selection.parentPath.some((ancestor) => ancestor.kind !== 'part'))) ||
    selection.parentPath.length + 1 > HOSTED_DEPTH_LIMIT ||
    (selection.before?.occurrenceId ?? null) !== input.beforeOccurrenceId ||
    (selection.before !== null && selection.before.parentId !== input.parentId) ||
    selection.occurrenceIdentityExists
  ) {
    invalidAnchor();
  }

  const siblingLength = await sequenceLength(indexes, 'siblings', selection.siblingRootId);
  const siblingStart =
    selection.before === null
      ? siblingLength
      : await selectedRank(indexes.siblings, selection.siblingRootId, selection.before.occurrenceId);
  const preorderLength = await sequenceLength(indexes, 'preorder', selection.preorderRootId);
  let preorderStart: bigint;
  if (selection.before !== null) {
    preorderStart = await selectedPreorderRank(indexes, selection.preorderRootId, selection.before.occurrenceId);
  } else if (parent === null) {
    preorderStart = preorderLength;
  } else {
    const parentRank = await selectedPreorderRank(indexes, selection.preorderRootId, parent.occurrenceId);
    preorderStart = parentRank + parent.subtreeSize;
  }
  if (preorderStart > preorderLength) invalidAnchor();

  const chapterStart = await insertionChapterRank(input, selection, indexes);
  const entryKind = input.placement.kind;
  const siblingRootId = await insertVersionedOutlineSequenceNode(
    indexes.siblings,
    selection.siblingRootId,
    siblingStart,
    input.occurrenceId,
    input.occurrenceId,
  );
  const preorderRootId = await insertVersionedOutlineSequenceNode(
    indexes.preorder,
    selection.preorderRootId,
    preorderStart,
    input.occurrenceId,
    input.occurrenceId,
    entryKind === 'chapter' ? 1n : 0n,
  );
  let chapterRootId = selection.chapterRootId;
  if (entryKind === 'chapter') {
    chapterRootId = await insertVersionedOutlineSequenceNode(
      indexes.chapters,
      selection.chapterRootId,
      chapterStart,
      input.occurrenceId,
      input.occurrenceId,
      1n,
    );
  }
  const chapterCount = entryKind === 'chapter' ? 1n : 0n;

  return {
    result: 'inserted',
    operation: 'insert',
    expectedRevisionId: input.expectedRevisionId,
    occurrenceId: input.occurrenceId,
    parentId: input.parentId,
    entryKind,
    siblingStart,
    siblingRootId,
    preorderStart,
    preorderCount: 1n,
    preorderRootId,
    chapterStart,
    chapterCount,
    chapterRootId,
    ancestorDeltas: ancestorDeltas(ancestorFacts(selection.parentPath), 1n, chapterCount),
    work: {
      siblings: indexes.siblings.work(),
      preorder: indexes.preorder.work(),
      chapters: indexes.chapters.work(),
    },
  };
}

async function prepareRemove(
  input: Extract<HostedVersionDraftPointInput, { operation: 'remove' }>,
  selection: Extract<HostedVersionDraftPointSelection, { operation: 'remove' }>,
  indexes: HostedVersionDraftPointIndexes,
): Promise<HostedVersionDraftPointPlan> {
  assertFactsInSnapshot(selection, [selection.source, ...selection.sourceAncestors]);
  const source = selection.source;
  assertAncestorChain(source.parentId, selection.sourceAncestors);
  if (
    source.occurrenceId !== input.occurrenceId ||
    source.subtreeSize < 1n ||
    source.chapterCount < 0n ||
    source.chapterCount > source.subtreeSize ||
    source.subtreeHeight < 0 ||
    selection.sourceAncestors.length + source.subtreeHeight + 1 > HOSTED_DEPTH_LIMIT ||
    (source.kind === 'chapter' &&
      (source.subtreeSize !== 1n || source.subtreeHeight !== 0 || source.chapterCount !== 1n))
  ) {
    invalidAnchor();
  }

  const siblingStart = await selectedRank(indexes.siblings, selection.siblingRootId, source.occurrenceId);
  const preorderStart = await selectedPreorderRank(indexes, selection.preorderRootId, source.occurrenceId);
  const preorderLength = await sequenceLength(indexes, 'preorder', selection.preorderRootId);
  if (preorderStart + source.subtreeSize > preorderLength) {
    throw new Error('Hosted version draft subtree exceeds the selected preorder');
  }
  const chapterStart = await chapterRankVersionedOutlineSequenceNode(
    indexes.preorder,
    selection.preorderRootId,
    source.occurrenceId,
  );
  if (chapterStart === null) invalidAnchor();

  const siblings = await spliceVersionedOutlineSequence(
    indexes.siblings,
    selection.siblingRootId,
    siblingStart,
    1n,
    null,
  );
  if (siblings.removedRootId === null) throw new Error('Hosted version draft could not detach the selected sibling');
  const detachedSibling = await indexes.siblings.readNode(siblings.removedRootId);
  if (detachedSibling?.value !== source.occurrenceId || detachedSibling.count !== 1n) {
    throw new Error('Hosted version draft detached a different sibling');
  }

  const preorder = await spliceVersionedOutlineSequence(
    indexes.preorder,
    selection.preorderRootId,
    preorderStart,
    source.subtreeSize,
    null,
  );
  if (preorder.removedRootId === null) throw new Error('Hosted version draft could not detach the selected subtree');
  const detachedPreorder = await indexes.preorder.readNode(preorder.removedRootId);
  if (detachedPreorder?.count !== source.subtreeSize || detachedPreorder.chapterCount !== source.chapterCount) {
    throw new Error('Hosted version draft detached a different subtree range');
  }

  let chapterRootId = selection.chapterRootId;
  if (source.chapterCount > 0n) {
    if (selection.chapterRootId === null) {
      throw new Error('Hosted version draft has chapter summaries without a chapter projection');
    }
    const chapters = await spliceVersionedOutlineSequence(
      indexes.chapters,
      selection.chapterRootId,
      chapterStart,
      source.chapterCount,
      null,
    );
    if (chapters.removedRootId === null) throw new Error('Hosted version draft could not detach the chapter range');
    const detachedChapters = await indexes.chapters.readNode(chapters.removedRootId);
    if (detachedChapters === null || detachedChapters.count !== source.chapterCount) {
      throw new Error('Hosted version draft detached a different chapter range');
    }
    chapterRootId = chapters.rootId;
  }

  return {
    result: 'removed',
    operation: 'remove',
    expectedRevisionId: input.expectedRevisionId,
    occurrenceId: source.occurrenceId,
    parentId: source.parentId,
    entryKind: null,
    siblingStart,
    siblingRootId: siblings.rootId,
    preorderStart,
    preorderCount: source.subtreeSize,
    preorderRootId: preorder.rootId,
    chapterStart,
    chapterCount: source.chapterCount,
    chapterRootId,
    ancestorDeltas: ancestorDeltas(selection.sourceAncestors, -source.subtreeSize, -source.chapterCount),
    work: {
      siblings: indexes.siblings.work(),
      preorder: indexes.preorder.work(),
      chapters: indexes.chapters.work(),
    },
  };
}

/**
 * Plan one insertion or subtree removal against a single immutable draft selection. The caller supplies
 * selected roots and starts one read/write overlay per index inside its transaction. No descendant rows
 * are read: removals cut the stored preorder and chapter aggregates as contiguous sequence ranges.
 */
export async function prepareHostedVersionDraftPointPlan(
  input: HostedVersionDraftPointInput,
  selection: HostedVersionDraftPointSelection,
  indexes: HostedVersionDraftPointIndexes,
): Promise<HostedVersionDraftPointPlan> {
  assertSnapshot(selection, input.expectedRevisionId);
  if (selection.operation !== input.operation) invalidAnchor();
  return input.operation === 'insert'
    ? prepareInsert(input, selection as Extract<HostedVersionDraftPointSelection, { operation: 'insert' }>, indexes)
    : prepareRemove(input, selection as Extract<HostedVersionDraftPointSelection, { operation: 'remove' }>, indexes);
}
