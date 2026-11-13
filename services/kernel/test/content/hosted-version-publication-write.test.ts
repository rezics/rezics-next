import { expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import type { OrderedHostedPlacement, HostedChapterTarget } from '../../src/content/hosted-chapters-model.ts';
import {
  HostedVersionPublicationWriteError,
  type HostedVersionPublicationValue,
  type HostedVersionPublicationIndexRoots,
  type HostedVersionPublicationOccurrence,
  type HostedVersionPublicationOccurrenceChange,
  type HostedVersionPublicationWritePort,
} from '../../src/content/hosted-version-publication-write-model.ts';
import {
  commitHostedVersionPublicationPoint,
  writeHostedVersionPublicationPoint,
} from '../../src/content/hosted-version-publication-write.ts';
import {
  createVersionedOutlineSequenceReadWriteSet,
  type VersionedOutlineChapterWeight,
  type VersionedOutlineSequenceNode,
  type VersionedOutlineSequenceReadWriteSet,
} from '../../src/content/versioned-outline-sequence.ts';
import type { HostedPointSelection } from '../../src/content/hosted-publication-point-selection.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from '../../src/content/hosted-version-store.ts';
import { commitHostedVersionRevision } from '../../src/content/hosted-version-revision.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlExecution, type SqlObserver } from './support/sql-observer.ts';
import commitVersion from '../../src/content/hosted-version-commit.sql';
import type { Pool, PoolClient } from 'pg';

setDefaultTimeout(180_000);

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

function buildTree(values: readonly string[], weight: (id: string) => VersionedOutlineChapterWeight = () => 1n): Tree {
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
      chapterWeight: weight(id),
      chapterCount: weight(id) + (left?.chapterCount ?? 0n) + (right?.chapterCount ?? 0n),
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

type NativeValue =
  | Readonly<{ kind: 'part'; title: string; chapterCount: bigint }>
  | Readonly<{ kind: 'chapter'; title: string; target: HostedChapterTarget; chapterCount: bigint }>;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function countPhysicalRows(record: SqlExecution) {
  const nodes = JSON.parse(String(record.parameters[5])) as readonly unknown[];
  const occurrences = JSON.parse(String(record.parameters[6])) as readonly unknown[];
  const siblingRoots = JSON.parse(String(record.parameters[7])) as readonly unknown[];
  return {
    indexNodes: nodes.length,
    occurrenceVersions: occurrences.length,
    siblingRootVersions: siblingRoots.length,
    snapshotVersions: 1,
    total: nodes.length + occurrences.length + siblingRoots.length + 1,
  };
}

function writeNativeTree(
  write: HostedVersionWrite<NativeValue>,
  index: 'sibling' | 'preorder' | 'chapter',
  tree: Tree,
  values: ReadonlyMap<string, NativeValue>,
): void {
  const sequence = hostedVersionSequence(write, index);
  for (const node of tree.nodes.values()) sequence.writeNode({ ...node, value: values.get(node.id)! });
}

function nativeInsertionSelection(input: {
  draftId: string;
  publicationId: string;
  partId: string;
  chapterId: string;
  anchor: OrderedHostedPlacement;
}): Extract<HostedPointSelection, { kind: 'publishChapter' }> {
  const selectedPart: OrderedHostedPlacement = {
    occurrenceId: input.partId,
    parentId: null,
    kind: 'part',
    position: input.anchor.position,
    ordinal: input.anchor.ordinal,
    title: 'New part',
  };
  const selectedChapter: OrderedHostedPlacement = {
    occurrenceId: input.chapterId,
    parentId: input.partId,
    kind: 'chapter',
    position: 0,
    ordinal: input.anchor.ordinal,
    title: 'New chapter',
    target: target('revision-new'),
  };
  return {
    kind: 'publishChapter',
    expectedRevisionId: input.draftId,
    expectedPublicationId: input.publicationId,
    chapter: selectedChapter,
    ancestors: [{ placement: selectedPart, before: input.anchor }],
    parentId: input.partId,
    beforeOccurrenceId: null,
    parent: null,
    before: null,
    changedPlacements: [selectedChapter],
  };
}

function nativeReplacementSelection(input: {
  draftId: string;
  publicationId: string;
  publicChapter: OrderedHostedPlacement;
  target: HostedChapterTarget;
}): Extract<HostedPointSelection, { kind: 'replacePublishedChapter' }> {
  if (input.publicChapter.kind !== 'chapter') throw new Error('Expected a chapter selection');
  const draftChapter = { ...input.publicChapter, target: input.target };
  return {
    kind: 'replacePublishedChapter',
    expectedRevisionId: input.draftId,
    expectedPublicationId: input.publicationId,
    publicChapter: input.publicChapter,
    draftChapter,
    changedPlacements: [draftChapter],
  };
}

test('binds a legacy baseline insertion and replacement to native snapshots and rolls back stale pointer CAS', async () => {
  const nativeFixture = await hostedChaptersFixture();
  const observer: SqlObserver = observeSql(nativeFixture.native.pool);
  try {
    const route = routeOf(nativeFixture.catalogueId)!;
    const pointers = (
      await nativeFixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
        `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
         WHERE route=$1 AND catalogue_id=$2`,
        [route, nativeFixture.catalogueId],
      )
    ).rows[0]!;
    const draftId = pointers.head_revision_id;
    const legacyPublicationId = nativeFixture.newOccurrenceId();
    const generationId = nativeFixture.newOccurrenceId();
    const stablePartId = nativeFixture.newOccurrenceId();
    const stableChildId = nativeFixture.newOccurrenceId();
    const topLevelIds = Array.from({ length: OLD_SIZE - 2 }, () => nativeFixture.newOccurrenceId());
    const allIds = [stablePartId, stableChildId, ...topLevelIds];
    const values = new Map<string, NativeValue>();
    values.set(stablePartId, { kind: 'part', title: 'Stable part', chapterCount: 1n });
    values.set(stableChildId, {
      kind: 'chapter',
      title: 'Stable child',
      target: target('revision-stable'),
      chapterCount: 1n,
    });
    topLevelIds.forEach((id, index) =>
      values.set(id, {
        kind: 'chapter',
        title: `Chapter ${index}`,
        target: target(`revision-${index}`),
        chapterCount: 1n,
      }),
    );
    const positions = new Map(topLevelIds.map((id, index) => [id, index + 1]));
    const rootWeight = (id: string): VersionedOutlineChapterWeight => (id === stablePartId ? 0n : 1n);
    const rootSiblings = buildTree([stablePartId, ...topLevelIds], rootWeight);
    const childSiblings = buildTree([stableChildId]);
    const siblingTree: Tree = {
      rootId: rootSiblings.rootId,
      nodes: new Map([...rootSiblings.nodes, ...childSiblings.nodes]),
    };
    const preorderTree = buildTree([stablePartId, stableChildId, ...topLevelIds], rootWeight);
    const chapterTree = buildTree([stableChildId, ...topLevelIds]);

    const baselineSnapshot = await transaction(nativeFixture.native.pool, async (tx) => {
      const initial = await createHostedVersionGeneration(tx, nativeFixture.catalogueId, generationId, 'candidate');
      const write = createHostedVersionWrite<NativeValue>(tx, initial);
      writeNativeTree(write, 'sibling', siblingTree, values);
      writeNativeTree(write, 'preorder', preorderTree, values);
      writeNativeTree(write, 'chapter', chapterTree, values);
      for (const id of allIds) {
        stageHostedVersionOccurrence(write, id, {
          parentOccurrenceId: id === stableChildId ? stablePartId : null,
          subtreeSize: id === stablePartId ? 2n : 1n,
          value: values.get(id)!,
        });
      }
      stageHostedVersionSiblingRoot(write, null, rootSiblings.rootId);
      stageHostedVersionSiblingRoot(write, stablePartId, childSiblings.rootId);
      stageHostedVersionSnapshotRoots(write, {
        preorderRootId: preorderTree.rootId,
        chapterRootId: chapterTree.rootId,
        placementCount: BigInt(OLD_SIZE),
        chapterCount: BigInt(OLD_SIZE - 1),
      });
      const baseline = await commitHostedVersionWrite(tx, write);
      await tx.query(
        `INSERT INTO content.hosted_structure_revision
           (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
         VALUES ($1,$2,$3,'publication',$4,$5,$6)`,
        [route, nativeFixture.catalogueId, legacyPublicationId, draftId, nativeFixture.newOccurrenceId(), new Date()],
      );
      await tx.query(
        `UPDATE content.hosted_catalogue SET publication_id=$3
         WHERE route=$1 AND catalogue_id=$2 AND head_revision_id=$4`,
        [route, nativeFixture.catalogueId, legacyPublicationId, draftId],
      );
      return baseline;
    });
    const writeStart = observer.records.length;

    const anchorId = topLevelIds[Math.floor(topLevelIds.length / 2)]!;
    const anchorOrdinal = positions.get(anchorId)!;
    const anchorValue = values.get(anchorId)!;
    if (anchorValue.kind !== 'chapter') throw new Error('Expected a chapter anchor');
    const anchor: OrderedHostedPlacement = {
      occurrenceId: anchorId,
      parentId: null,
      position: anchorOrdinal,
      ordinal: anchorOrdinal,
      kind: 'chapter',
      title: anchorValue.title,
      target: anchorValue.target,
    };
    const insertRevisionId = nativeFixture.newOccurrenceId();
    const inserted = await transaction(nativeFixture.native.pool, (tx) =>
      commitHostedVersionPublicationPoint(tx, {
        catalogueId: nativeFixture.catalogueId,
        revisionId: insertRevisionId,
        recordedTransactionId: nativeFixture.newOccurrenceId(),
        recordedAt: new Date().toISOString(),
        selection: nativeInsertionSelection({
          draftId,
          publicationId: legacyPublicationId,
          partId: nativeFixture.newOccurrenceId(),
          chapterId: nativeFixture.newOccurrenceId(),
          anchor,
        }),
        preparedBaseline: { sourcePublicationId: legacyPublicationId, snapshot: baselineSnapshot },
      }),
    );
    expect(inserted.plan.logicalWork.touchedIndexPathNodes).toBeLessThan(512);
    expect(inserted.plan.occurrenceChanges.length).toBeGreaterThan(1);
    expect(inserted.plan.siblingRootChanges.some((change) => change.parentId === stablePartId)).toBe(false);
    expect(
      (await readHostedVersionSiblingRoot(nativeFixture.native.pool, inserted.snapshot, stablePartId))?.rootNodeId,
    ).toBe(childSiblings.rootId);
    expect(
      (await readHostedVersionOccurrence<NativeValue>(nativeFixture.native.pool, inserted.snapshot, stableChildId))
        ?.parentOccurrenceId,
    ).toBe(stablePartId);

    const replacementId = topLevelIds[100]!;
    const oldReplacementValue = values.get(replacementId)!;
    if (oldReplacementValue.kind !== 'chapter') throw new Error('Expected a chapter replacement');
    const replacementRevisionId = nativeFixture.newOccurrenceId();
    const replacement = await transaction(nativeFixture.native.pool, (tx) =>
      commitHostedVersionPublicationPoint(tx, {
        catalogueId: nativeFixture.catalogueId,
        revisionId: replacementRevisionId,
        recordedTransactionId: nativeFixture.newOccurrenceId(),
        recordedAt: new Date().toISOString(),
        selection: nativeReplacementSelection({
          draftId,
          publicationId: insertRevisionId,
          publicChapter: {
            occurrenceId: replacementId,
            parentId: null,
            position: positions.get(replacementId)!,
            ordinal: positions.get(replacementId)!,
            kind: 'chapter',
            title: oldReplacementValue.title,
            target: oldReplacementValue.target,
          },
          target: target('revision-replacement'),
        }),
        preparedBaseline: null,
      }),
    );
    expect(replacement.plan.logicalWork.touchedIndexPathNodes).toBe(0);
    expect(replacement.plan.occurrenceChanges).toHaveLength(1);
    const replacedOccurrence = await readHostedVersionOccurrence<NativeValue>(
      nativeFixture.native.pool,
      replacement.snapshot,
      replacementId,
    );
    expect(replacedOccurrence?.value.kind).toBe('chapter');
    if (replacedOccurrence?.value.kind !== 'chapter') throw new Error('Expected a replaced chapter occurrence');
    expect(replacedOccurrence.value.target).toEqual(target('revision-replacement'));
    const oldOccurrence = await readHostedVersionOccurrence<NativeValue>(
      nativeFixture.native.pool,
      baselineSnapshot,
      replacementId,
    );
    expect(oldOccurrence?.value.kind).toBe('chapter');
    if (oldOccurrence?.value.kind !== 'chapter') throw new Error('Expected an old chapter occurrence');
    expect(oldOccurrence.value.target).toEqual(oldReplacementValue.target);
    expect(
      (await readHostedVersionSiblingRoot(nativeFixture.native.pool, baselineSnapshot, stablePartId))?.rootNodeId,
    ).toBe(childSiblings.rootId);

    const staleRevisionId = nativeFixture.newOccurrenceId();
    await nativeFixture.native.pool.query(
      `UPDATE content.hosted_catalogue SET publication_id=$3 WHERE route=$1 AND catalogue_id=$2`,
      [route, nativeFixture.catalogueId, legacyPublicationId],
    );
    await expect(
      transaction(nativeFixture.native.pool, (tx) =>
        commitHostedVersionPublicationPoint(tx, {
          catalogueId: nativeFixture.catalogueId,
          revisionId: staleRevisionId,
          recordedTransactionId: nativeFixture.newOccurrenceId(),
          recordedAt: new Date().toISOString(),
          selection: nativeReplacementSelection({
            draftId,
            publicationId: replacementRevisionId,
            publicChapter: {
              occurrenceId: replacementId,
              parentId: null,
              position: positions.get(replacementId)!,
              ordinal: positions.get(replacementId)!,
              kind: 'chapter',
              title: oldReplacementValue.title,
              target: target('revision-replacement'),
            },
            target: target('revision-stale'),
          }),
          preparedBaseline: null,
        }),
      ),
    ).rejects.toBeInstanceOf(HostedVersionPublicationWriteError);
    await nativeFixture.native.pool.query(
      `UPDATE content.hosted_catalogue SET publication_id=$3 WHERE route=$1 AND catalogue_id=$2`,
      [route, nativeFixture.catalogueId, replacementRevisionId],
    );

    const exactOldSnapshot = await readHostedVersionSnapshot(
      nativeFixture.native.pool,
      nativeFixture.catalogueId,
      generationId,
      baselineSnapshot.sequence,
    );
    expect(exactOldSnapshot).toEqual(baselineSnapshot);
    const finalPointers = (
      await nativeFixture.native.pool.query<{ head_revision_id: string; publication_id: string }>(
        `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
         WHERE route=$1 AND catalogue_id=$2`,
        [route, nativeFixture.catalogueId],
      )
    ).rows[0]!;
    expect(finalPointers).toEqual({ head_revision_id: draftId, publication_id: replacementRevisionId });
    expect(
      await readHostedVersionSnapshot(nativeFixture.native.pool, nativeFixture.catalogueId, generationId, 4n),
    ).toBeNull();
    const staleRevision = await nativeFixture.native.pool.query(
      `SELECT 1 FROM content.hosted_structure_revision WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
      [route, nativeFixture.catalogueId, staleRevisionId],
    );
    expect(staleRevision.rows).toHaveLength(0);

    const pointCommitRecords = observer.records
      .slice(writeStart)
      .filter((record) => record.statement === commitVersion.sql);
    expect(pointCommitRecords).toHaveLength(3);
    const insertedRows = countPhysicalRows(pointCommitRecords[0]!);
    expect(inserted.plan.logicalWork.touchedIndexPathNodes).toBe(insertedRows.indexNodes);
    expect(insertedRows).toMatchObject({
      occurrenceVersions: inserted.plan.logicalWork.changedOccurrences,
      siblingRootVersions: inserted.plan.logicalWork.changedSiblingRoots,
      snapshotVersions: 1,
    });
    const replacementRows = countPhysicalRows(pointCommitRecords[1]!);
    expect(replacement.plan.logicalWork.touchedIndexPathNodes).toBe(0);
    expect(replacementRows).toMatchObject({
      indexNodes: 0,
      occurrenceVersions: 1,
      siblingRootVersions: 0,
      snapshotVersions: 1,
    });
    expect(pointCommitRecords.map(countPhysicalRows).map(({ total }) => total)).toHaveLength(3);
    expect(observer.records.slice(writeStart).filter((record) => /\bbody\b/i.test(record.statement))).toHaveLength(0);
  } finally {
    await observer.close();
    await nativeFixture.close();
  }
});
