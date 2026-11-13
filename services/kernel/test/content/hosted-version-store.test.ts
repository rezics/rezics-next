import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { HostedVersionHeadChangedError, type HostedVersionSnapshot } from '../../src/content/hosted-version-model.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionGeneration,
  createHostedVersionWrite,
  readHostedVersionHead,
  readHostedVersionNode,
  readHostedVersionOccurrence,
  readHostedVersionSnapshot,
  readHostedVersionSiblingRoot,
  stageHostedVersionNode,
  stageHostedVersionOccurrence,
  stageHostedVersionSiblingRoot,
  stageHostedVersionSnapshotRoots,
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

  // The logical probe counter follows adapter calls; the observer independently records driver statements.
  const logical = { nodes: 0, occurrences: 0, siblingRoots: 0, snapshots: 0, heads: 0 };
  const nodeAt = (snapshot: HostedVersionSnapshot, id: string, kind: 'sibling' | 'preorder' | 'chapter') => {
    logical.nodes++;
    return readHostedVersionNode<Record<string, unknown>>(native.pool, snapshot, kind, id);
  };
  const occurrenceAt = (snapshot: HostedVersionSnapshot, id: string) => {
    logical.occurrences++;
    return readHostedVersionOccurrence<Record<string, unknown>>(native.pool, snapshot, id);
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

  const firstWrite = createHostedVersionWrite(draft);
  stageHostedVersionNode(firstWrite, 'sibling', firstPart, null, { label: 'superseded', count: 3n });
  stageHostedVersionNode(firstWrite, 'sibling', firstPart, null, {
    label: 'first',
    count: 9_007_199_254_740_995n,
  });
  stageHostedVersionNode(firstWrite, 'preorder', firstPart, null, { label: 'preorder', count: 2n });
  stageHostedVersionOccurrence(firstWrite, firstPart, {
    parentOccurrenceId: secondPart,
    subtreeSize: 1n,
    value: { title: 'nested in Book', exactRevision: 'r1' },
  });
  stageHostedVersionOccurrence(firstWrite, firstPart, {
    parentOccurrenceId: secondPart,
    subtreeSize: 1n,
    value: { title: 'final first', exactRevision: 'r2' },
  });
  stageHostedVersionSiblingRoot(firstWrite, null, secondPart);
  stageHostedVersionSiblingRoot(firstWrite, secondPart, firstPart);
  stageHostedVersionSnapshotRoots(firstWrite, {
    preorderRootId: secondPart,
    chapterRootId: null,
    placementCount: 2n,
    chapterCount: 0n,
  });
  draft = await commitHostedVersionWrite(native.pool, firstWrite);
  expect(draft.sequence).toBe(1n);

  const snapshotOne = await snapshotAt(draftId, 1n);
  expect(snapshotOne).not.toBeNull();
  const firstNode = await nodeAt(snapshotOne!, firstPart, 'sibling');
  expect(firstNode).toMatchObject({ nodeId: firstPart, treeParentId: null, sequence: 1n });
  expect(firstNode?.value).toEqual({ label: 'first', count: 9_007_199_254_740_995n });
  expect((await occurrenceAt(snapshotOne!, firstPart))?.parentOccurrenceId).toBe(secondPart);
  expect((await siblingRootAt(snapshotOne!, secondPart))?.rootNodeId).toBe(firstPart);

  const secondWrite = createHostedVersionWrite(snapshotOne!);
  stageHostedVersionNode(secondWrite, 'sibling', firstPart, null, { label: 'updated', count: 11n });
  stageHostedVersionOccurrence(secondWrite, firstPart, {
    parentOccurrenceId: null,
    subtreeSize: 1n,
    value: { title: 'updated first', exactRevision: 'r3' },
  });
  draft = await commitHostedVersionWrite(native.pool, secondWrite);
  const exactTwo = await snapshotAt(draftId, 2n);
  expect((await nodeAt(exactTwo!, firstPart, 'sibling'))?.value).toEqual({ label: 'updated', count: 11n });
  expect((await occurrenceAt(exactTwo!, firstPart))?.parentOccurrenceId).toBeNull();
  expect((await occurrenceAt(snapshotOne!, firstPart))?.parentOccurrenceId).toBe(secondPart);

  const removalWrite = createHostedVersionWrite(exactTwo!);
  stageHostedVersionNode(removalWrite, 'sibling', firstPart, null, null);
  stageHostedVersionNode(removalWrite, 'preorder', firstPart, null, null);
  stageHostedVersionOccurrence(removalWrite, firstPart, null);
  stageHostedVersionSiblingRoot(removalWrite, secondPart, null);
  stageHostedVersionSnapshotRoots(removalWrite, {
    preorderRootId: secondPart,
    chapterRootId: null,
    placementCount: 1n,
    chapterCount: 0n,
  });
  draft = await commitHostedVersionWrite(native.pool, removalWrite);
  const exactThree = await snapshotAt(draftId, 3n);
  expect(await nodeAt(exactThree!, firstPart, 'sibling')).toBeNull();
  expect(await occurrenceAt(exactThree!, firstPart)).toBeNull();
  expect((await siblingRootAt(exactThree!, secondPart))?.rootNodeId).toBeNull();
  expect((await nodeAt(exactTwo!, firstPart, 'sibling'))?.value).toEqual({ label: 'updated', count: 11n });

  const candidateWrite = createHostedVersionWrite(candidate);
  stageHostedVersionNode(candidateWrite, 'sibling', secondPart, null, { label: 'private candidate', count: 99n });
  stageHostedVersionOccurrence(candidateWrite, secondPart, {
    parentOccurrenceId: null,
    subtreeSize: 1n,
    value: { title: 'candidate-only' },
  });
  stageHostedVersionSiblingRoot(candidateWrite, null, secondPart);
  stageHostedVersionSnapshotRoots(candidateWrite, {
    preorderRootId: secondPart,
    chapterRootId: null,
    placementCount: 1n,
    chapterCount: 0n,
  });
  candidate = await commitHostedVersionWrite(native.pool, candidateWrite);
  expect((await nodeAt(candidate, secondPart, 'sibling'))?.value).toEqual({
    label: 'private candidate',
    count: 99n,
  });
  expect(await nodeAt(exactThree!, secondPart, 'sibling')).toBeNull();
  expect((await headAt(draftId))?.sequence).toBe(3n);
  expect((await headAt(candidateId))?.sequence).toBe(1n);

  // A stale sequence cannot backdate into a newer generation head.
  const staleWrite = createHostedVersionWrite(snapshotOne!);
  stageHostedVersionNode(staleWrite, 'sibling', secondPart, null, { label: 'stale write' });
  await expect(commitHostedVersionWrite(native.pool, staleWrite)).rejects.toBeInstanceOf(HostedVersionHeadChangedError);

  const logicalEnd = { ...logical };
  const physical = {
    nodes: observer.records.filter((record) => record.statement === readNode.sql).length,
    occurrences: observer.records.filter((record) => record.statement === readOccurrence.sql).length,
    siblingRoots: observer.records.filter((record) => record.statement === readSiblingRoot.sql).length,
    snapshots: observer.records.filter((record) => record.statement === readSnapshot.sql).length,
    heads: observer.records.filter((record) => record.statement === readHead.sql).length,
  };
  expect(logicalEnd).toEqual(physical);
  expect(observer.records.filter((record) => record.statement === createGeneration.sql)).toHaveLength(2);
  expect(observer.records.filter((record) => record.statement === commitVersion.sql)).toHaveLength(5);

  const storeSql = new Set([
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
