import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  insertVersionedOutlineSequenceNode,
  rankVersionedOutlineSequenceNode,
  spliceVersionedOutlineSequence,
} from '../../src/content/versioned-outline-sequence.ts';
import { routeOf } from '../../src/route/route.ts';
import { HostedVersionHeadChangedError, type HostedVersionSnapshot } from '../../src/content/hosted-version-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionHead,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
  readHostedVersionSnapshot,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
  type HostedVersionWrite,
} from '../../src/content/hosted-version-store.ts';
import createGeneration from '../../src/content/hosted-version-create-generation.sql';
import commitVersion from '../../src/content/hosted-version-commit.sql';
import readHead from '../../src/content/hosted-version-read-head.sql';
import readNode from '../../src/content/hosted-version-read-node.sql';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';
import readSnapshot from '../../src/content/hosted-version-read-snapshot.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlObserver } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let activeObserver: SqlObserver | undefined;
let closeFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
  await activeObserver?.close();
  activeObserver = undefined;
  await closeFixture?.();
  closeFixture = undefined;
});

type BookNodeValue = Readonly<{ label: string; count: bigint }>;
type BookWrite = HostedVersionWrite<BookNodeValue>;

test('keeps exact temporal state and private generations separate from the legacy Book format', async () => {
  const fixture = await hostedChaptersFixture();
  closeFixture = fixture.close;
  const { native } = fixture;
  const observer = observeSql(native.pool);
  activeObserver = observer;

  const firstPart = fixture.newOccurrenceId();
  const secondPart = fixture.newOccurrenceId();
  const legacyCreated = await native.command('/v1/hostedCatalogues', {
    postId: fixture.catalogueId,
    threadId: fixture.threadId,
    placements: [
      { occurrenceId: firstPart, parentId: null, position: 0, title: 'First', kind: 'part' },
      { occurrenceId: secondPart, parentId: null, position: 1, title: 'Second', kind: 'part' },
    ],
  });
  const path = `/v1/hostedCatalogues/${fixture.catalogueId}`;
  const legacyBefore = await native.call('GET', `${path}/children?kind=structure`);
  expect(legacyBefore.status).toBe(200);
  expect(legacyBefore.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    firstPart,
    secondPart,
  ]);
  const route = routeOf(fixture.catalogueId)!;
  const oldCatalogue = (
    await native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
      [route, fixture.catalogueId],
    )
  ).rows[0]!;

  const draftId = fixture.newOccurrenceId();
  const candidateId = fixture.newOccurrenceId();
  let draft = await createHostedVersionGeneration(native.pool, fixture.catalogueId, draftId, 'draft');
  let candidate = await createHostedVersionGeneration(native.pool, fixture.catalogueId, candidateId, 'candidate');
  expect(draft).toMatchObject({ sequence: 0n, generationKind: 'draft' });
  expect(candidate).toMatchObject({ sequence: 0n, generationKind: 'candidate' });

  const sequenceContexts: BookWrite[] = [];
  const writeFor = (snapshot: HostedVersionSnapshot) => {
    const write = createHostedVersionWrite<BookNodeValue>(native.pool, snapshot);
    sequenceContexts.push(write);
    return write;
  };
  const sequence = (write: BookWrite, index: 'sibling' | 'preorder' | 'chapter') => hostedVersionSequence(write, index);
  const nodeAt = async (snapshot: HostedVersionSnapshot, id: string, index: 'sibling' | 'preorder' | 'chapter') =>
    sequence(writeFor(snapshot), index).readNode(id);

  const logical = { occurrences: 0, siblingRoots: 0, snapshots: 0, heads: 0 };
  const occurrenceAt = (snapshot: HostedVersionSnapshot, id: string) => {
    logical.occurrences++;
    return readHostedVersionOccurrence<BookNodeValue>(native.pool, snapshot, id);
  };
  const siblingRootAt = (snapshot: HostedVersionSnapshot, parentId: string | null) => {
    logical.siblingRoots++;
    return readHostedVersionSiblingRoot(native.pool, snapshot, parentId);
  };
  const snapshotAt = (id: string, sequence: bigint) => {
    logical.snapshots++;
    return readHostedVersionSnapshot(native.pool, fixture.catalogueId, id, sequence);
  };
  const headAt = (id: string) => {
    logical.heads++;
    return readHostedVersionHead(native.pool, fixture.catalogueId, id);
  };

  const firstWrite = writeFor(draft);
  const siblingSet = sequence(firstWrite, 'sibling');
  const topRoot = await insertVersionedOutlineSequenceNode(siblingSet, null, 0n, secondPart, {
    label: 'second',
    count: 2n,
  });
  const childRoot = await insertVersionedOutlineSequenceNode(siblingSet, null, 0n, firstPart, {
    label: 'superseded',
    count: 3n,
  });
  const stagedChild = (await siblingSet.readNode(firstPart))!;
  siblingSet.writeNode({ ...stagedChild, value: { label: 'first', count: 9_007_199_254_740_995n } });
  const preorderSet = sequence(firstWrite, 'preorder');
  let preorderRoot = await insertVersionedOutlineSequenceNode(
    preorderSet,
    null,
    0n,
    secondPart,
    {
      label: 'preorder second',
      count: 1n,
    },
    1n,
  );
  preorderRoot = await insertVersionedOutlineSequenceNode(preorderSet, preorderRoot, 1n, firstPart, {
    label: 'preorder first',
    count: 1n,
  });
  const chapterRoot = await insertVersionedOutlineSequenceNode(
    sequence(firstWrite, 'chapter'),
    null,
    0n,
    secondPart,
    { label: 'chapter-only index', count: 7n },
    1n,
  );
  stageHostedVersionOccurrence(firstWrite, firstPart, {
    parentOccurrenceId: secondPart,
    subtreeSize: 1n,
    value: { label: 'final first', count: 2n },
  });
  stageHostedVersionSiblingRoot(firstWrite, null, topRoot);
  stageHostedVersionSiblingRoot(firstWrite, secondPart, childRoot);
  stageHostedVersionSnapshotRoots(firstWrite, {
    preorderRootId: preorderRoot,
    chapterRootId: chapterRoot,
    placementCount: 2n,
    chapterCount: 1n,
  });
  draft = await commitHostedVersionWrite(native.pool, firstWrite);
  expect(draft.sequence).toBe(1n);

  const snapshotOne = await snapshotAt(draftId, 1n);
  expect(snapshotOne).not.toBeNull();
  const firstNode = await nodeAt(snapshotOne!, firstPart, 'sibling');
  expect(firstNode).toMatchObject({ id: firstPart, treeParentId: null });
  expect(firstNode?.value).toEqual({ label: 'first', count: 9_007_199_254_740_995n });
  expect((await nodeAt(snapshotOne!, secondPart, 'chapter'))?.value).toEqual({
    label: 'chapter-only index',
    count: 7n,
  });
  expect((await occurrenceAt(snapshotOne!, firstPart))?.parentOccurrenceId).toBe(secondPart);
  expect((await siblingRootAt(snapshotOne!, secondPart))?.rootNodeId).toBe(firstPart);

  const secondWrite = writeFor(snapshotOne!);
  const previousChild = (await sequence(secondWrite, 'sibling').readNode(firstPart))!;
  sequence(secondWrite, 'sibling').writeNode({ ...previousChild, value: { label: 'updated', count: 11n } });
  stageHostedVersionOccurrence(secondWrite, firstPart, {
    parentOccurrenceId: null,
    subtreeSize: 1n,
    value: { label: 'updated first', count: 3n },
  });
  draft = await commitHostedVersionWrite(native.pool, secondWrite);
  const exactTwo = await snapshotAt(draftId, 2n);
  expect(exactTwo).not.toBeNull();
  expect((await nodeAt(exactTwo!, firstPart, 'sibling'))?.value).toEqual({ label: 'updated', count: 11n });
  expect((await occurrenceAt(exactTwo!, firstPart))?.parentOccurrenceId).toBeNull();
  expect((await occurrenceAt(snapshotOne!, firstPart))?.parentOccurrenceId).toBe(secondPart);

  const removalWrite = writeFor(exactTwo!);
  const oldChildRoot = (await siblingRootAt(exactTwo!, secondPart))?.rootNodeId ?? null;
  const siblingRemoval = await spliceVersionedOutlineSequence(
    sequence(removalWrite, 'sibling'),
    oldChildRoot,
    0n,
    1n,
    null,
  );
  const preorderRemoval = await spliceVersionedOutlineSequence(
    sequence(removalWrite, 'preorder'),
    exactTwo!.preorderRootId,
    1n,
    1n,
    null,
  );
  stageHostedVersionOccurrence(removalWrite, firstPart, null);
  stageHostedVersionSiblingRoot(removalWrite, secondPart, siblingRemoval.rootId);
  stageHostedVersionSnapshotRoots(removalWrite, {
    preorderRootId: preorderRemoval.rootId,
    chapterRootId: null,
    placementCount: 1n,
    chapterCount: 0n,
  });
  draft = await commitHostedVersionWrite(native.pool, removalWrite);
  const exactThree = await snapshotAt(draftId, 3n);
  expect(exactThree).not.toBeNull();
  expect(await occurrenceAt(exactThree!, firstPart)).toBeNull();
  expect((await occurrenceAt(exactTwo!, firstPart))?.value).toEqual({ label: 'updated first', count: 3n });
  expect((await nodeAt(snapshotOne!, firstPart, 'sibling'))?.value).toEqual({
    label: 'first',
    count: 9_007_199_254_740_995n,
  });
  expect((await nodeAt(exactTwo!, firstPart, 'sibling'))?.value).toEqual({ label: 'updated', count: 11n });
  expect((await siblingRootAt(exactThree!, secondPart))?.rootNodeId).toBeNull();
  const currentMembership = writeFor(exactThree!);
  expect(
    await rankVersionedOutlineSequenceNode(
      sequence(currentMembership, 'preorder'),
      exactThree!.preorderRootId,
      firstPart,
    ),
  ).toBeNull();
  expect(
    await rankVersionedOutlineSequenceNode(
      sequence(writeFor(exactTwo!), 'preorder'),
      exactTwo!.preorderRootId,
      firstPart,
    ),
  ).toBe(1n);

  const candidateWrite = writeFor(candidate);
  const candidateRoot = await insertVersionedOutlineSequenceNode(
    sequence(candidateWrite, 'sibling'),
    null,
    0n,
    secondPart,
    { label: 'private candidate', count: 99n },
  );
  stageHostedVersionOccurrence(candidateWrite, secondPart, {
    parentOccurrenceId: null,
    subtreeSize: 1n,
    value: { label: 'candidate-only', count: 99n },
  });
  stageHostedVersionSiblingRoot(candidateWrite, null, candidateRoot);
  stageHostedVersionSnapshotRoots(candidateWrite, {
    preorderRootId: candidateRoot,
    chapterRootId: null,
    placementCount: 1n,
    chapterCount: 0n,
  });
  candidate = await commitHostedVersionWrite(native.pool, candidateWrite);
  expect((await nodeAt(candidate, secondPart, 'sibling'))?.value).toEqual({ label: 'private candidate', count: 99n });
  expect((await nodeAt(exactThree!, secondPart, 'sibling'))?.value).toEqual({ label: 'second', count: 2n });
  expect((await occurrenceAt(candidate, secondPart))?.value).toEqual({ label: 'candidate-only', count: 99n });
  expect((await headAt(draftId))?.sequence).toBe(3n);
  expect((await headAt(candidateId))?.sequence).toBe(1n);

  // Competing writes from an older sequence cannot backdate into the newer head.
  const staleWrite = writeFor(snapshotOne!);
  await expect(commitHostedVersionWrite(native.pool, staleWrite)).rejects.toBeInstanceOf(HostedVersionHeadChangedError);

  const sequenceWork = sequenceContexts.flatMap((write) =>
    (['sibling', 'preorder', 'chapter'] as const).map((index) => sequence(write, index).work()),
  );
  const logicalNodeReadCalls = sequenceWork.reduce((total, work) => total + work.nodeReadCalls, 0);
  const logicalSnapshotProbes = sequenceWork.reduce((total, work) => total + work.snapshotProbeCount, 0);
  const physical = {
    nodeStatements: observer.records.filter((record) => record.statement === readNode.sql).length,
    occurrenceStatements: observer.records.filter((record) => record.statement === readOccurrence.sql).length,
    siblingRootStatements: observer.records.filter((record) => record.statement === readSiblingRoot.sql).length,
    snapshotStatements: observer.records.filter((record) => record.statement === readSnapshot.sql).length,
    headStatements: observer.records.filter((record) => record.statement === readHead.sql).length,
  };
  expect(physical.nodeStatements).toBe(logicalSnapshotProbes);
  expect(logicalNodeReadCalls).toBeGreaterThanOrEqual(physical.nodeStatements);
  expect(physical.occurrenceStatements).toBe(logical.occurrences);
  expect(physical.siblingRootStatements).toBe(logical.siblingRoots);
  expect(physical.snapshotStatements).toBe(logical.snapshots);
  expect(physical.headStatements).toBe(logical.heads);
  expect(observer.records.filter((record) => record.statement === createGeneration.sql)).toHaveLength(2);
  expect(observer.records.filter((record) => record.statement === commitVersion.sql)).toHaveLength(5);

  const storeSql = new Set<string>([
    createGeneration.sql,
    commitVersion.sql,
    readHead.sql,
    readNode.sql,
    readOccurrence.sql,
    readSiblingRoot.sql,
    readSnapshot.sql,
  ]);
  const storeReads = observer.records.filter((record) => storeSql.has(record.statement));
  expect(
    storeReads.every((record) =>
      /content\.hosted_(tree_generation|tree_snapshot_version|order_node_version|occurrence_state_version|sibling_root_version)/.test(
        record.statement,
      ),
    ),
  ).toBe(true);
  expect(
    storeReads.some((record) => /content\.(post|thread|hosted_placement|hosted_append)/.test(record.statement)),
  ).toBe(false);

  const legacyAfter = await native.call('GET', `${path}/children?kind=structure`);
  expect(legacyAfter.value).toEqual(legacyBefore.value);
  const currentCatalogue = (
    await native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
      [route, fixture.catalogueId],
    )
  ).rows[0]!;
  expect(currentCatalogue).toEqual(oldCatalogue);
  expect(legacyCreated.revisionId).toBe(oldCatalogue.head_revision_id);
});
