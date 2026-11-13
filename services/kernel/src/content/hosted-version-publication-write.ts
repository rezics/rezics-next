import { InvalidHostedStructureError } from './hosted-chapters-model.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-limits.ts';
import type { OrderedHostedPlacement, HostedChapterTarget } from './hosted-chapters-model.ts';
import {
  chapterRankVersionedOutlineSequenceNode,
  insertVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
} from './versioned-outline-sequence.ts';
import {
  HostedVersionPublicationWriteError,
  type HostedVersionPublicationIndexRoots,
  type HostedVersionPublicationIndexes,
  type HostedVersionPublicationInsertion,
  type HostedVersionPublicationOccurrence,
  type HostedVersionPublicationOccurrenceChange,
  type HostedVersionPublicationValue,
  type HostedVersionPublicationWritePlan,
  type HostedVersionPublicationWritePort,
} from './hosted-version-publication-write-model.ts';
import type { HostedPointSelection } from './hosted-publication-point-selection.ts';

type Insertion = Readonly<{
  placement: OrderedHostedPlacement;
  parentId: string | null;
  before: OrderedHostedPlacement | null;
}>;

function valueOf(placement: OrderedHostedPlacement): HostedVersionPublicationValue {
  return placement.kind === 'part'
    ? { kind: 'part', title: placement.title }
    : { kind: 'chapter', title: placement.title, target: placement.target };
}

function sameTarget(left: HostedChapterTarget, right: HostedChapterTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

function chapterValue(
  value: HostedVersionPublicationValue,
): Extract<HostedVersionPublicationValue, { kind: 'chapter' }> | null {
  return value.kind === 'chapter' ? value : null;
}

function assertExpectedPublication(selection: HostedPointSelection, port: HostedVersionPublicationWritePort): void {
  if (
    selection.expectedPublicationId !== port.snapshot.publicationRevisionId ||
    port.snapshot.generationKind !== 'candidate' ||
    port.snapshot.sequence < 0n
  ) {
    throw new HostedVersionPublicationWriteError('stale-publication');
  }
}

async function sequenceLength(
  indexes: HostedVersionPublicationIndexes,
  index: 'siblings' | 'preorder' | 'chapters',
  rootId: string | null,
): Promise<bigint> {
  if (rootId === null) return 0n;
  const root = await indexes[index].readNode(rootId);
  if (root === null || root.treeParentId !== null) {
    throw new Error('Hosted publication sequence root is not selected');
  }
  return root.count;
}

async function selectedRank(
  index: HostedVersionPublicationIndexes['siblings'] | HostedVersionPublicationIndexes['preorder'],
  rootId: string | null,
  occurrenceId: string,
): Promise<bigint> {
  const rank = await rankVersionedOutlineSequenceNode(index, rootId, occurrenceId);
  if (rank === null) throw new Error('Hosted publication anchor is absent from its selected sequence');
  return rank;
}

async function preorderInsertionRank(
  insertion: Insertion,
  parent: HostedVersionPublicationOccurrence | null,
  indexes: HostedVersionPublicationIndexes,
  preorderRootId: string | null,
): Promise<bigint> {
  if (insertion.before !== null) return selectedRank(indexes.preorder, preorderRootId, insertion.before.occurrenceId);
  if (insertion.parentId === null) return sequenceLength(indexes, 'preorder', preorderRootId);
  if (parent === null) throw new Error('Hosted publication insertion parent is not selected');
  const parentRank = await selectedRank(indexes.preorder, preorderRootId, insertion.parentId);
  return parentRank + parent.subtreeSize;
}

async function chapterInsertionRank(
  insertion: Insertion,
  parent: HostedVersionPublicationOccurrence | null,
  indexes: HostedVersionPublicationIndexes,
  preorderRootId: string | null,
  chapterRootId: string | null,
): Promise<bigint> {
  if (insertion.before !== null) {
    const rank = await chapterRankVersionedOutlineSequenceNode(
      indexes.preorder,
      preorderRootId,
      insertion.before.occurrenceId,
    );
    if (rank === null) throw new Error('Hosted publication chapter anchor is absent from preorder');
    return rank;
  }
  if (insertion.parentId === null) return sequenceLength(indexes, 'chapters', chapterRootId);
  if (parent === null) throw new Error('Hosted publication chapter parent is not selected');
  const rank = await chapterRankVersionedOutlineSequenceNode(indexes.preorder, preorderRootId, insertion.parentId);
  if (rank === null) throw new Error('Hosted publication chapter parent is absent from preorder');
  return rank + parent.chapterCount;
}

function insertionList(selection: Extract<HostedPointSelection, { kind: 'publishChapter' }>): Insertion[] {
  return [
    ...selection.ancestors.map(({ placement, before }) => ({
      placement,
      parentId: placement.parentId,
      before,
    })),
    {
      placement: selection.chapter,
      parentId: selection.parentId,
      before: selection.before,
    },
  ];
}

function indexWork(indexes: HostedVersionPublicationIndexes): HostedVersionPublicationWritePlan['logicalWork'] {
  const siblings = indexes.siblings.work();
  const preorder = indexes.preorder.work();
  const chapters = indexes.chapters.work();
  return {
    siblings,
    preorder,
    chapters,
    touchedIndexPathNodes: siblings.writtenNodeCount + preorder.writtenNodeCount + chapters.writtenNodeCount,
    changedOccurrences: 0,
    changedSiblingRoots: 0,
  };
}

/**
 * Apply a point-publication delta to one candidate-publication overlay. Reads are rooted in the exact publication
 * named by the selection. The caller owns native authorization, final currentness, receipt/event writes and commit.
 */
export async function writeHostedVersionPublicationPoint(
  selection: HostedPointSelection,
  port: HostedVersionPublicationWritePort,
): Promise<HostedVersionPublicationWritePlan> {
  assertExpectedPublication(selection, port);

  const indexes = port.indexes;
  const occurrenceChanges = new Map<string, HostedVersionPublicationOccurrenceChange>();
  const occurrenceReads = new Map<string, Promise<HostedVersionPublicationOccurrence | null>>();
  const siblingRootChanges = new Map<string | null, string | null>();
  const siblingRootReads = new Map<string | null, Promise<string | null>>();
  const insertions: HostedVersionPublicationInsertion[] = [];
  let preorderRootId = port.snapshot.preorderRootId;
  let chapterRootId = port.snapshot.chapterRootId;

  async function occurrence(occurrenceId: string): Promise<HostedVersionPublicationOccurrence | null> {
    const staged = occurrenceChanges.get(occurrenceId);
    if (staged) return staged;
    let read = occurrenceReads.get(occurrenceId);
    if (!read) {
      read = port.readOccurrence(occurrenceId);
      occurrenceReads.set(occurrenceId, read);
    }
    return read;
  }

  async function siblingRoot(parentId: string | null): Promise<string | null> {
    if (siblingRootChanges.has(parentId)) return siblingRootChanges.get(parentId)!;
    let read = siblingRootReads.get(parentId);
    if (!read) {
      read = port.readSiblingRoot(parentId);
      siblingRootReads.set(parentId, read);
    }
    return read;
  }

  async function parentPath(
    parentId: string | null,
  ): Promise<readonly Readonly<{ occurrenceId: string; value: HostedVersionPublicationOccurrence }>[]> {
    const path: { occurrenceId: string; value: HostedVersionPublicationOccurrence }[] = [];
    const visited = new Set<string>();
    let currentId = parentId;
    while (currentId !== null) {
      if (visited.has(currentId)) throw new Error('Hosted publication parent chain contains a cycle');
      visited.add(currentId);
      const current = await occurrence(currentId);
      if (current === null) throw new Error('Hosted publication parent is absent from its selected snapshot');
      path.push({ occurrenceId: currentId, value: current });
      if (path.length + 1 > HOSTED_DEPTH_LIMIT)
        throw new InvalidHostedStructureError('The selected chapter exceeds the hosted depth limit');
      currentId = current.parentId;
    }
    return path;
  }

  async function incrementAncestors(parentId: string | null, chapterDelta: bigint): Promise<void> {
    for (const ancestor of await parentPath(parentId)) {
      occurrenceChanges.set(ancestor.occurrenceId, {
        occurrenceId: ancestor.occurrenceId,
        ...ancestor.value,
        subtreeSize: ancestor.value.subtreeSize + 1n,
        chapterCount: ancestor.value.chapterCount + chapterDelta,
      });
    }
  }

  if (selection.kind === 'replacePublishedChapter') {
    const publicChapter = selection.publicChapter;
    const draftChapter = selection.draftChapter;
    if (publicChapter.kind !== 'chapter' || draftChapter.kind !== 'chapter') {
      throw new Error('Hosted publication replacement does not select chapter occurrences');
    }
    const current = await occurrence(publicChapter.occurrenceId);
    if (current === null) {
      throw new Error('Hosted publication replacement is absent from its selected snapshot');
    }
    const currentValue = chapterValue(current.value);
    if (currentValue === null) {
      throw new Error('Hosted publication replacement does not select a chapter');
    }
    if (
      current.parentId !== publicChapter.parentId ||
      currentValue.title !== publicChapter.title ||
      !sameTarget(currentValue.target, publicChapter.target)
    ) {
      throw new Error('Hosted publication replacement does not match its selected occurrence');
    }
    const change: HostedVersionPublicationOccurrenceChange = {
      occurrenceId: publicChapter.occurrenceId,
      ...current,
      value: { ...currentValue, target: draftChapter.target },
    };
    occurrenceChanges.set(change.occurrenceId, change);
  } else {
    const pending = insertionList(selection);
    const insertedIds = new Set<string>();
    let placementCount = port.snapshot.placementCount;
    let chapterCount = port.snapshot.chapterCount;

    for (const insertion of pending) {
      const { placement, parentId, before } = insertion;
      if (insertedIds.has(placement.occurrenceId))
        throw new InvalidHostedStructureError('A selected occurrence may be published only once');
      insertedIds.add(placement.occurrenceId);

      const parent = parentId === null ? null : await occurrence(parentId);
      if (parentId !== null && parent === null)
        throw new Error('Hosted publication insertion parent is absent from its selected snapshot');
      const path = await parentPath(parentId);
      if (path.length + 1 > HOSTED_DEPTH_LIMIT)
        throw new InvalidHostedStructureError('The selected chapter exceeds the hosted depth limit');

      const currentSiblingRootId = await siblingRoot(parentId);
      const siblingRank =
        before === null
          ? await sequenceLength(indexes, 'siblings', currentSiblingRootId)
          : await selectedRank(indexes.siblings, currentSiblingRootId, before.occurrenceId);
      const preorderRank = await preorderInsertionRank(insertion, parent, indexes, preorderRootId);
      const chapterRank =
        placement.kind === 'chapter'
          ? await chapterInsertionRank(insertion, parent, indexes, preorderRootId, chapterRootId)
          : null;

      const nextSiblingRootId = await insertVersionedOutlineSequenceNode(
        indexes.siblings,
        currentSiblingRootId,
        siblingRank,
        placement.occurrenceId,
        placement.occurrenceId,
      );
      preorderRootId = await insertVersionedOutlineSequenceNode(
        indexes.preorder,
        preorderRootId,
        preorderRank,
        placement.occurrenceId,
        placement.occurrenceId,
        placement.kind === 'chapter' ? 1n : 0n,
      );
      if (placement.kind === 'chapter') {
        chapterRootId = await insertVersionedOutlineSequenceNode(
          indexes.chapters,
          chapterRootId,
          chapterRank!,
          placement.occurrenceId,
          placement.occurrenceId,
          1n,
        );
      }

      const chapterWeight = placement.kind === 'chapter' ? 1n : 0n;
      const newOccurrence: HostedVersionPublicationOccurrenceChange = {
        occurrenceId: placement.occurrenceId,
        parentId,
        subtreeSize: 1n,
        chapterCount: chapterWeight,
        value: valueOf(placement),
      };
      occurrenceChanges.set(placement.occurrenceId, newOccurrence);
      siblingRootChanges.set(parentId, nextSiblingRootId);
      await incrementAncestors(parentId, chapterWeight);
      placementCount += 1n;
      chapterCount += chapterWeight;
      insertions.push({
        occurrenceId: placement.occurrenceId,
        parentId,
        kind: placement.kind,
        siblingRank,
        preorderRank,
        chapterRank,
      });
    }

    port.stageSnapshotRoots({ preorderRootId, chapterRootId, placementCount, chapterCount });
  }

  for (const change of occurrenceChanges.values()) port.stageOccurrence(change);
  for (const [parentId, rootId] of siblingRootChanges) port.stageSiblingRoot(parentId, rootId);

  const work = indexWork(indexes);
  return {
    kind: selection.kind,
    expectedRevisionId: selection.expectedRevisionId,
    expectedPublicationId: selection.expectedPublicationId,
    expectedGenerationId: port.snapshot.generationId,
    expectedSequence: port.snapshot.sequence,
    nextSequence: port.snapshot.sequence + 1n,
    roots: {
      preorderRootId,
      chapterRootId,
      placementCount:
        selection.kind === 'publishChapter'
          ? port.snapshot.placementCount + BigInt(insertions.length)
          : port.snapshot.placementCount,
      chapterCount:
        selection.kind === 'publishChapter'
          ? port.snapshot.chapterCount + BigInt(insertions.filter((item) => item.kind === 'chapter').length)
          : port.snapshot.chapterCount,
    },
    insertions,
    occurrenceChanges: [...occurrenceChanges.values()],
    siblingRootChanges: [...siblingRootChanges].map(([parentId, rootId]) => ({ parentId, rootId })),
    logicalWork: {
      ...work,
      changedOccurrences: occurrenceChanges.size,
      changedSiblingRoots: siblingRootChanges.size,
    },
  };
}
