import {
  chapterRankVersionedOutlineSequenceNode,
  moveVersionedOutlineSequenceRange,
  rankVersionedOutlineSequenceNode,
  selectVersionedOutlineSequenceNode,
  spliceVersionedOutlineSequence,
} from './versioned-outline-sequence.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-model.ts';
import {
  HostedVersionDraftMoveError,
  type HostedVersionDraftMoveAncestor,
  type HostedVersionDraftMoveAncestorDelta,
  type HostedVersionDraftMoveIndexes,
  type HostedVersionDraftMoveInput,
  type HostedVersionDraftMovePlan,
  type HostedVersionDraftMoveSelection,
} from './hosted-version-draft-edit-model.ts';

function invalidAnchor(): never {
  throw new HostedVersionDraftMoveError('invalid-anchor');
}

function assertSnapshot(selection: HostedVersionDraftMoveSelection, expectedRevisionId: string): void {
  if (selection.headRevisionId !== expectedRevisionId || selection.snapshotId !== expectedRevisionId) {
    throw new HostedVersionDraftMoveError('stale-head');
  }
  const facts = [
    selection.source,
    ...(selection.destinationParent === null ? [] : [selection.destinationParent]),
    ...(selection.before === null ? [] : [selection.before]),
    ...selection.sourceAncestors,
    ...selection.destinationAncestors,
  ];
  if (facts.some((fact) => fact.snapshotId !== selection.snapshotId)) invalidAnchor();
}

function assertAncestorChain(parentId: string | null, ancestors: readonly HostedVersionDraftMoveAncestor[]): void {
  if ((ancestors[0]?.occurrenceId ?? null) !== parentId) invalidAnchor();
  for (let index = 0; index < ancestors.length; index += 1) {
    if (ancestors[index]!.parentId !== (ancestors[index + 1]?.occurrenceId ?? null)) invalidAnchor();
  }
}

async function sequenceLength(
  indexes: HostedVersionDraftMoveIndexes['siblings'],
  rootId: string | null,
): Promise<bigint> {
  if (rootId === null) return 0n;
  const root = await indexes.readNode(rootId);
  if (root === null || root.treeParentId !== null) {
    throw new Error('Hosted version draft selected a detached sibling root incorrectly');
  }
  return root.count;
}

async function selectedRank(
  access: HostedVersionDraftMoveIndexes['siblings'],
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
  indexes: HostedVersionDraftMoveIndexes,
  rootId: string | null,
  occurrenceId: string,
): Promise<bigint> {
  return selectedRank(indexes.preorder, rootId, occurrenceId);
}

function ancestorDeltas(
  sourcePath: readonly HostedVersionDraftMoveAncestor[],
  destinationPath: readonly HostedVersionDraftMoveAncestor[],
  movedSize: bigint,
  movedChapters: bigint,
): readonly HostedVersionDraftMoveAncestorDelta[] {
  const deltas = new Map<
    string,
    { fact: HostedVersionDraftMoveAncestor; subtreeSizeDelta: bigint; chapterCountDelta: bigint }
  >();
  for (const [path, direction] of [
    [sourcePath, -1n],
    [destinationPath, 1n],
  ] as const) {
    for (const fact of path) {
      const current = deltas.get(fact.occurrenceId);
      if (current) {
        current.subtreeSizeDelta += direction * movedSize;
        current.chapterCountDelta += direction * movedChapters;
      } else {
        deltas.set(fact.occurrenceId, {
          fact,
          subtreeSizeDelta: direction * movedSize,
          chapterCountDelta: direction * movedChapters,
        });
      }
    }
  }
  return [...deltas.values()]
    .filter((entry) => entry.subtreeSizeDelta !== 0n || entry.chapterCountDelta !== 0n)
    .map(({ fact, subtreeSizeDelta, chapterCountDelta }) => ({
      occurrenceId: fact.occurrenceId,
      subtreeSizeDelta,
      chapterCountDelta,
      subtreeSize: fact.subtreeSize + subtreeSizeDelta,
      chapterCount: fact.chapterCount + chapterCountDelta,
    }));
}

function assertNonnegativeAncestorSummaries(deltas: readonly HostedVersionDraftMoveAncestorDelta[]): void {
  if (deltas.some((entry) => entry.subtreeSize < 1n || entry.chapterCount < 0n)) {
    throw new Error('Hosted version draft move produced a negative ancestor summary');
  }
}

/**
 * Resolve stable anchors on one selected draft and stage only sequence-boundary writes.
 * The caller owns author admission, receipt replay, the transaction and expected-head CAS;
 * these indexes must read that same pinned snapshot and stage into its transaction overlay.
 */
export async function prepareHostedVersionDraftMovePlan(
  input: HostedVersionDraftMoveInput,
  selection: HostedVersionDraftMoveSelection,
  indexes: HostedVersionDraftMoveIndexes,
): Promise<HostedVersionDraftMovePlan> {
  assertSnapshot(selection, input.expectedRevisionId);
  const { source, destinationParent, before } = selection;
  const destinationParentId = destinationParent?.occurrenceId ?? null;
  if (
    source.occurrenceId !== input.occurrenceId ||
    destinationParentId !== input.parentId ||
    (destinationParent !== null && destinationParent.kind !== 'part') ||
    source.subtreeSize < 1n ||
    source.chapterCount < 0n ||
    source.subtreeHeight < 0 ||
    (before?.occurrenceId ?? null) !== input.beforeOccurrenceId ||
    (before !== null && before.parentId !== input.parentId) ||
    (before !== null && before.occurrenceId === source.occurrenceId)
  ) {
    invalidAnchor();
  }
  assertAncestorChain(source.parentId, selection.sourceAncestors);
  assertAncestorChain(destinationParentId, selection.destinationAncestors);
  if (selection.destinationAncestors.length + source.subtreeHeight > HOSTED_DEPTH_LIMIT) invalidAnchor();
  if (source.parentId === destinationParentId && selection.sourceSiblingRootId !== selection.destinationSiblingRootId) {
    throw new Error('Hosted version draft selection returned different sibling roots for one parent');
  }

  const sourceSiblingRank = await selectedRank(indexes.siblings, selection.sourceSiblingRootId, source.occurrenceId);
  const sourcePreorderRank = await selectedPreorderRank(indexes, selection.preorderRootId, source.occurrenceId);
  const destinationPreorderRank =
    destinationParent === null
      ? null
      : await selectedPreorderRank(indexes, selection.preorderRootId, destinationParent.occurrenceId);
  const preorderLength = await sequenceLength(indexes.preorder, selection.preorderRootId);
  if (sourcePreorderRank + source.subtreeSize > preorderLength) {
    throw new Error('Hosted version draft subtree exceeds the selected preorder');
  }
  if (
    destinationPreorderRank !== null &&
    destinationPreorderRank >= sourcePreorderRank &&
    destinationPreorderRank < sourcePreorderRank + source.subtreeSize
  ) {
    invalidAnchor();
  }

  const destinationSiblingLength = await sequenceLength(indexes.siblings, selection.destinationSiblingRootId);
  const destinationSiblingRank =
    before === null
      ? destinationSiblingLength
      : await selectedRank(indexes.siblings, selection.destinationSiblingRootId, before.occurrenceId);
  const beforePreorderRank =
    before === null ? null : await selectedPreorderRank(indexes, selection.preorderRootId, before.occurrenceId);
  if (
    beforePreorderRank !== null &&
    beforePreorderRank >= sourcePreorderRank &&
    beforePreorderRank < sourcePreorderRank + source.subtreeSize
  ) {
    invalidAnchor();
  }

  const preorderDestination =
    beforePreorderRank ??
    (destinationParent === null ? preorderLength : destinationPreorderRank! + destinationParent.subtreeSize);
  if (preorderDestination > preorderLength) {
    throw new Error('Hosted version draft destination exceeds the selected preorder');
  }

  const sourceChapterRank = await chapterRankVersionedOutlineSequenceNode(
    indexes.preorder,
    selection.preorderRootId,
    source.occurrenceId,
  );
  if (sourceChapterRank === null) invalidAnchor();
  const beforeChapterRank =
    before === null
      ? null
      : await chapterRankVersionedOutlineSequenceNode(indexes.preorder, selection.preorderRootId, before.occurrenceId);
  if (before !== null && beforeChapterRank === null) invalidAnchor();
  let chapterDestination: bigint;
  if (beforeChapterRank !== null) {
    chapterDestination = beforeChapterRank;
  } else if (destinationParent === null) {
    chapterDestination = await sequenceLength(indexes.chapters, selection.chapterRootId);
  } else {
    const destinationParentChapterRank = await chapterRankVersionedOutlineSequenceNode(
      indexes.preorder,
      selection.preorderRootId,
      destinationParent.occurrenceId,
    );
    if (destinationParentChapterRank === null) invalidAnchor();
    chapterDestination = destinationParentChapterRank + destinationParent.chapterCount;
  }

  const sameParent = source.parentId === destinationParentId;
  const samePosition =
    sameParent &&
    (destinationSiblingRank === sourceSiblingRank + 1n ||
      (before === null && sourceSiblingRank + 1n === destinationSiblingLength));
  const ancestorUpdates = samePosition
    ? []
    : ancestorDeltas(
        selection.sourceAncestors,
        selection.destinationAncestors,
        source.subtreeSize,
        source.chapterCount,
      );
  assertNonnegativeAncestorSummaries(ancestorUpdates);

  let sourceSiblingRootId = selection.sourceSiblingRootId;
  let destinationSiblingRootId = selection.destinationSiblingRootId;
  let preorderRootId = selection.preorderRootId;
  let chapterRootId = selection.chapterRootId;
  if (!samePosition) {
    if (sameParent) {
      const moved = await moveVersionedOutlineSequenceRange(
        indexes.siblings,
        selection.sourceSiblingRootId,
        sourceSiblingRank,
        1n,
        destinationSiblingRank,
      );
      sourceSiblingRootId = moved.rootId;
      destinationSiblingRootId = moved.rootId;
    } else {
      const cut = await spliceVersionedOutlineSequence(
        indexes.siblings,
        selection.sourceSiblingRootId,
        sourceSiblingRank,
        1n,
        null,
      );
      if (cut.removedRootId === null) {
        throw new Error('Hosted version draft could not detach the selected sibling');
      }
      const detached = await indexes.siblings.readNode(cut.removedRootId);
      if (detached?.value !== source.occurrenceId || detached.count !== 1n) {
        throw new Error('Hosted version draft detached a different sibling');
      }
      const inserted = await spliceVersionedOutlineSequence(
        indexes.siblings,
        selection.destinationSiblingRootId,
        destinationSiblingRank,
        0n,
        cut.removedRootId,
      );
      sourceSiblingRootId = cut.rootId;
      destinationSiblingRootId = inserted.rootId;
    }
    preorderRootId = (
      await moveVersionedOutlineSequenceRange(
        indexes.preorder,
        selection.preorderRootId,
        sourcePreorderRank,
        source.subtreeSize,
        preorderDestination,
      )
    ).rootId;
    if (source.chapterCount > 0n) {
      if (selection.chapterRootId === null) {
        throw new Error('Hosted version draft has chapter summaries without a chapter projection');
      }
      chapterRootId = (
        await moveVersionedOutlineSequenceRange(
          indexes.chapters,
          selection.chapterRootId,
          sourceChapterRank,
          source.chapterCount,
          chapterDestination,
        )
      ).rootId;
    }
  }

  return {
    result: samePosition ? 'no-op' : 'moved',
    expectedRevisionId: input.expectedRevisionId,
    occurrenceId: source.occurrenceId,
    fromParentId: source.parentId,
    toParentId: destinationParentId,
    sourceSiblingRootId,
    destinationSiblingRootId,
    preorderRootId,
    chapterRootId,
    preorderStart: sourcePreorderRank,
    preorderCount: source.subtreeSize,
    preorderDestination,
    chapterStart: sourceChapterRank,
    chapterCount: source.chapterCount,
    chapterDestination,
    ancestorDeltas: ancestorUpdates,
    work: {
      siblings: indexes.siblings.work(),
      preorder: indexes.preorder.work(),
      chapters: indexes.chapters.work(),
    },
  };
}
