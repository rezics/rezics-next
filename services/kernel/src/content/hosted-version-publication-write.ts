import { InvalidHostedStructureError } from './hosted-chapters-model.ts';
import { HOSTED_DEPTH_LIMIT } from './hosted-chapters-limits.ts';
import type { OrderedHostedPlacement, HostedChapterTarget } from './hosted-chapters-model.ts';
import type { CommandTransaction } from '../command/command.ts';
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
  type HostedVersionPublicationBaseline,
  type HostedVersionPublicationValue,
  type HostedVersionPublicationWritePlan,
  type HostedVersionPublicationWritePort,
} from './hosted-version-publication-write-model.ts';
import type { HostedPointSelection } from './hosted-publication-point-selection.ts';
import { HostedVersionHeadChangedError, type HostedVersionSnapshot } from './hosted-version-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from './hosted-version-store.ts';
import {
  commitHostedVersionRevision,
  HostedVersionRevisionPointerChangedError,
  resolveHostedVersionRevision,
} from './hosted-version-revision.ts';
import type {
  VersionedOutlineSequenceNode,
  VersionedOutlineSequenceReadWriteSet,
} from './versioned-outline-sequence.ts';

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

function matchesSelectedPlacement(
  occurrence: HostedVersionPublicationOccurrence | null,
  placement: OrderedHostedPlacement,
): boolean {
  if (occurrence === null || occurrence.parentId !== placement.parentId) return false;
  if (placement.kind === 'part') return occurrence.value.kind === 'part' && occurrence.value.title === placement.title;
  return (
    occurrence.value.kind === 'chapter' &&
    occurrence.value.title === placement.title &&
    sameTarget(occurrence.value.target, placement.target)
  );
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

  if (selection.kind === 'publishChapter') {
    const anchors = [...selection.ancestors.map(({ before }) => before), selection.before];
    for (const anchor of anchors) {
      if (anchor !== null && !matchesSelectedPlacement(await occurrence(anchor.occurrenceId), anchor)) {
        throw new HostedVersionPublicationWriteError('stale-publication');
      }
    }
    if (
      selection.parent !== null &&
      !matchesSelectedPlacement(await occurrence(selection.parent.occurrenceId), selection.parent)
    ) {
      throw new HostedVersionPublicationWriteError('stale-publication');
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

type StoredPublicationValue = HostedVersionPublicationValue & Readonly<{ chapterCount: bigint }>;
type StoredPublicationIndex = VersionedOutlineSequenceReadWriteSet<StoredPublicationValue>;
type PublicationWrite = HostedVersionWrite<StoredPublicationValue>;

function storedValue(value: HostedVersionPublicationValue, chapterCount: bigint): StoredPublicationValue {
  return { ...value, chapterCount };
}

function publicationValue(value: StoredPublicationValue): HostedVersionPublicationValue {
  return value.kind === 'part'
    ? { kind: 'part', title: value.title }
    : { kind: 'chapter', title: value.title, target: value.target };
}

function stringIndex(
  inner: StoredPublicationIndex,
  payloads: Map<string, StoredPublicationValue>,
): VersionedOutlineSequenceReadWriteSet<string> {
  const asString = (
    node: VersionedOutlineSequenceNode<StoredPublicationValue> | null,
  ): VersionedOutlineSequenceNode<string> | null => {
    if (node === null) return null;
    payloads.set(node.id, node.value);
    return { ...node, value: node.id };
  };
  const nodeReads = new Map<string, VersionedOutlineSequenceNode<string> | null>();
  const nodeWrites = new Map<string, VersionedOutlineSequenceNode<string>>();
  return {
    async readNode(id) {
      const node = asString(await inner.readNode(id));
      nodeReads.set(id, node);
      return node;
    },
    writeNode(node) {
      const value =
        payloads.get(node.id) ?? inner.nodeWrites.get(node.id)?.value ?? inner.nodeReads.get(node.id)?.value;
      if (value === undefined) throw new Error('Hosted publication sequence write has no occurrence value');
      inner.writeNode({ ...node, value });
      nodeWrites.set(node.id, node);
    },
    nodeReads,
    nodeWrites,
    work: () => inner.work(),
  };
}

function baselineSnapshotMatches(left: HostedVersionSnapshot, right: HostedVersionSnapshot): boolean {
  return (
    left.route === right.route &&
    left.catalogueId === right.catalogueId &&
    left.generationId === right.generationId &&
    left.generationKind === right.generationKind &&
    left.sequence === right.sequence &&
    left.preorderRootId === right.preorderRootId &&
    left.chapterRootId === right.chapterRootId &&
    left.placementCount === right.placementCount &&
    left.chapterCount === right.chapterCount
  );
}

async function exactPublicationSnapshot(
  client: CommandTransaction,
  catalogueId: string,
  selection: HostedPointSelection,
  preparedBaseline: HostedVersionPublicationBaseline | null,
): Promise<HostedVersionSnapshot> {
  const resolved = await resolveHostedVersionRevision(client, catalogueId, selection.expectedPublicationId);
  if (resolved.kind === 'missing' || resolved.revisionKind !== 'publication') {
    throw new HostedVersionPublicationWriteError('stale-publication');
  }

  if (resolved.kind === 'ordered') {
    if (resolved.snapshot.generationKind !== 'candidate') {
      throw new HostedVersionPublicationWriteError('stale-publication');
    }
    const snapshot = await readHostedVersionSnapshot(
      client,
      catalogueId,
      resolved.snapshot.generationId,
      resolved.snapshot.sequence,
    );
    if (
      snapshot === null ||
      snapshot.generationKind !== 'candidate' ||
      snapshot.sequence !== resolved.snapshot.sequence
    ) {
      throw new HostedVersionPublicationWriteError('stale-publication');
    }
    return snapshot;
  }

  if (
    preparedBaseline === null ||
    preparedBaseline.sourcePublicationId !== selection.expectedPublicationId ||
    preparedBaseline.snapshot.generationKind !== 'candidate' ||
    preparedBaseline.snapshot.catalogueId !== catalogueId
  ) {
    throw new HostedVersionPublicationWriteError('stale-publication');
  }
  const snapshot = await readHostedVersionSnapshot(
    client,
    catalogueId,
    preparedBaseline.snapshot.generationId,
    preparedBaseline.snapshot.sequence,
  );
  if (
    snapshot === null ||
    snapshot.generationKind !== 'candidate' ||
    !baselineSnapshotMatches(snapshot, preparedBaseline.snapshot)
  ) {
    throw new HostedVersionPublicationWriteError('stale-publication');
  }
  return snapshot;
}

function nativePublicationPort(
  client: CommandTransaction,
  snapshot: HostedVersionSnapshot,
  selection: HostedPointSelection,
  write: PublicationWrite,
): HostedVersionPublicationWritePort {
  const payloads = new Map<string, StoredPublicationValue>();
  if (selection.kind === 'publishChapter') {
    for (const { placement } of selection.ancestors)
      payloads.set(placement.occurrenceId, storedValue(valueOf(placement), 0n));
    payloads.set(
      selection.chapter.occurrenceId,
      storedValue(valueOf(selection.chapter), selection.chapter.kind === 'chapter' ? 1n : 0n),
    );
  }
  const indexes: HostedVersionPublicationIndexes = {
    siblings: stringIndex(hostedVersionSequence(write, 'sibling'), payloads),
    preorder: stringIndex(hostedVersionSequence(write, 'preorder'), payloads),
    chapters: stringIndex(hostedVersionSequence(write, 'chapter'), payloads),
  };
  return {
    snapshot: {
      publicationRevisionId: selection.expectedPublicationId,
      generationId: snapshot.generationId,
      generationKind: 'candidate',
      sequence: snapshot.sequence,
      preorderRootId: snapshot.preorderRootId,
      chapterRootId: snapshot.chapterRootId,
      placementCount: snapshot.placementCount,
      chapterCount: snapshot.chapterCount,
    },
    indexes,
    async readOccurrence(occurrenceId) {
      const row = await readHostedVersionOccurrence<StoredPublicationValue>(client, snapshot, occurrenceId);
      if (row === null) return null;
      return {
        parentId: row.parentOccurrenceId,
        subtreeSize: row.subtreeSize,
        chapterCount: row.value.chapterCount,
        value: publicationValue(row.value),
      };
    },
    async readSiblingRoot(parentId) {
      return (await readHostedVersionSiblingRoot(client, snapshot, parentId))?.rootNodeId ?? null;
    },
    stageOccurrence(change) {
      stageHostedVersionOccurrence(write, change.occurrenceId, {
        parentOccurrenceId: change.parentId,
        subtreeSize: change.subtreeSize,
        value: storedValue(change.value, change.chapterCount),
      });
    },
    stageSiblingRoot(parentId, rootId) {
      stageHostedVersionSiblingRoot(write, parentId, rootId);
    },
    stageSnapshotRoots(roots) {
      stageHostedVersionSnapshotRoots(write, roots);
    },
  };
}

export type HostedVersionPublicationPointCommitInput = Readonly<{
  catalogueId: string;
  revisionId: string;
  recordedTransactionId: string;
  recordedAt: string;
  selection: HostedPointSelection;
  preparedBaseline: HostedVersionPublicationBaseline | null;
}>;

export type HostedVersionPublicationPointCommit = Readonly<{
  snapshot: HostedVersionSnapshot;
  plan: HostedVersionPublicationWritePlan;
}>;

/** Apply one point selection and bind its descriptor and publication CAS on the caller's command transaction. */
export async function commitHostedVersionPublicationPoint(
  client: CommandTransaction,
  input: HostedVersionPublicationPointCommitInput,
): Promise<HostedVersionPublicationPointCommit> {
  const snapshot = await exactPublicationSnapshot(client, input.catalogueId, input.selection, input.preparedBaseline);
  const write = createHostedVersionWrite<StoredPublicationValue>(client, snapshot);
  const port = nativePublicationPort(client, snapshot, input.selection, write);
  const plan = await writeHostedVersionPublicationPoint(input.selection, port);
  try {
    const next = await commitHostedVersionWrite(client, write);
    await commitHostedVersionRevision(client, {
      revisionKind: 'publication',
      revisionId: input.revisionId,
      snapshot: {
        route: next.route,
        catalogueId: next.catalogueId,
        generationId: next.generationId,
        generationKind: 'candidate',
        sequence: next.sequence,
      },
      expectedDraftRevisionId: input.selection.expectedRevisionId,
      expectedPublicationId: input.selection.expectedPublicationId,
      recordedTransactionId: input.recordedTransactionId,
      recordedAt: input.recordedAt,
    });
    return { snapshot: next, plan };
  } catch (error) {
    if (error instanceof HostedVersionHeadChangedError || error instanceof HostedVersionRevisionPointerChangedError)
      throw new HostedVersionPublicationWriteError('stale-publication');
    throw error;
  }
}
