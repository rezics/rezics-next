import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
} from '../../src/content/hosted-version-store.ts';
import { readHostedDraftPointSnapshot } from '../../src/content/hosted-version-draft-write.ts';
import { selectVersionedOutlineSequenceNode } from '../../src/content/versioned-outline-sequence.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlObserver } from './support/sql-observer.ts';
import readChildDepth from '../../src/content/hosted-version-read-child-depth.sql';
import commitVersion from '../../src/content/hosted-version-commit.sql';
import readNode from '../../src/content/hosted-version-read-node.sql';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';

setDefaultTimeout(180_000);

let closeFixture: (() => Promise<void>) | undefined;
let activeObserver: SqlObserver | undefined;

afterEach(async () => {
  await activeObserver?.close();
  activeObserver = undefined;
  await closeFixture?.();
  closeFixture = undefined;
});

test('nested draft moves repair depth after subtree moves and removals at the exact limit', async () => {
  const fixture = await hostedChaptersFixture();
  closeFixture = fixture.close;
  const { native, catalogueId, newOccurrenceId } = fixture;
  const created = await native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: fixture.threadId,
    placements: [],
  });
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const observer = observeSql(native.pool);
  activeObserver = observer;
  let expectedRevisionId = created.revisionId;

  const send = (method: string, body: Record<string, unknown>, key = crypto.randomUUID()) =>
    native.call('POST', `${path}:${method}`, body, { key });

  const destinations = [newOccurrenceId()];
  const destinationRoot = await send('insertDraftPoint', {
    expectedRevisionId,
    occurrenceId: destinations[0],
    parentId: null,
    beforeOccurrenceId: null,
    title: 'Destination root',
    placement: { kind: 'part' },
  });
  expect(destinationRoot.status).toBe(200);
  expectedRevisionId = destinationRoot.value.revisionId as string;
  for (let index = 1; index < 8; index += 1) destinations.push(newOccurrenceId());
  let parentId: string | null = destinations[0]!;
  for (let index = 1; index < destinations.length; index += 1) {
    const result = await send('insertDraftPoint', {
      expectedRevisionId,
      occurrenceId: destinations[index],
      parentId,
      beforeOccurrenceId: null,
      title: `Destination ${index}`,
      placement: { kind: 'part' },
    });
    expect(result.status).toBe(200);
    expectedRevisionId = result.value.revisionId as string;
    parentId = destinations[index]!;
  }

  const emptyPartId = newOccurrenceId();
  const emptyResult = await send('insertDraftPoint', {
    expectedRevisionId,
    occurrenceId: emptyPartId,
    parentId: null,
    beforeOccurrenceId: null,
    title: 'Empty part',
    placement: { kind: 'part' },
  });
  expect(emptyResult.status).toBe(200);
  expectedRevisionId = emptyResult.value.revisionId as string;

  const deepIds = Array.from({ length: 12 }, () => newOccurrenceId());
  parentId = null;
  for (let index = 0; index < deepIds.length; index += 1) {
    const result = await send('insertDraftPoint', {
      expectedRevisionId,
      occurrenceId: deepIds[index],
      parentId,
      beforeOccurrenceId: null,
      title: `Deep part ${index}`,
      placement: { kind: 'part' },
    });
    expect(result.status).toBe(200);
    expectedRevisionId = result.value.revisionId as string;
    parentId = deepIds[index]!;
  }

  const bounded = (records: readonly SqlObserver['records'][number][]) => {
    const probes: readonly string[] = [readNode.sql, readOccurrence.sql, readSiblingRoot.sql, readChildDepth.sql];
    expect(records.filter((entry) => probes.includes(entry.statement)).length).toBeLessThan(512);
    const commit = records.find((entry) => entry.statement === commitVersion.sql);
    expect(commit).toBeDefined();
    const nodes = JSON.parse(String(commit!.parameters[5])) as unknown[];
    const occurrences = JSON.parse(String(commit!.parameters[6])) as unknown[];
    expect(nodes.length).toBeLessThan(512);
    expect(occurrences.length).toBeLessThan(32);
  };

  const moveStart = observer.records.length;
  const replayKey = crypto.randomUUID();
  const movedDeep = await send(
    'moveDraftPoint',
    { expectedRevisionId, occurrenceId: deepIds[0], parentId: emptyPartId, beforeOccurrenceId: null },
    replayKey,
  );
  expect(movedDeep.status).toBe(200);
  const underEmptyRevisionId = movedDeep.value.revisionId as string;
  bounded(observer.records.slice(moveStart));
  expect(
    (
      await send(
        'moveDraftPoint',
        { expectedRevisionId, occurrenceId: deepIds[0], parentId: emptyPartId, beforeOccurrenceId: null },
        replayKey,
      )
    ).value.revisionId,
  ).toBe(underEmptyRevisionId);
  expectedRevisionId = underEmptyRevisionId;

  const emptyParentSnapshot = await readHostedDraftPointSnapshot(native.pool, catalogueId, underEmptyRevisionId);
  expect(emptyParentSnapshot).not.toBeNull();
  const emptyParent = await readHostedVersionOccurrence<{ kind: string; subtreeHeight: number }>(
    native.pool,
    emptyParentSnapshot!,
    emptyPartId,
  );
  expect(emptyParent?.parentOccurrenceId).toBeNull();
  expect(emptyParent?.value.subtreeHeight).toBe(12);

  const atLimitStart = observer.records.length;
  const underDestination = await send('moveDraftPoint', {
    expectedRevisionId,
    occurrenceId: emptyPartId,
    parentId: destinations[2],
    beforeOccurrenceId: null,
  });
  expect(underDestination.status).toBe(200);
  const destinationRevisionId = underDestination.value.revisionId as string;
  bounded(observer.records.slice(atLimitStart));
  expectedRevisionId = destinationRevisionId;

  const tooDeep = await send('moveDraftPoint', {
    expectedRevisionId,
    occurrenceId: emptyPartId,
    parentId: destinations[3],
    beforeOccurrenceId: null,
  });
  expect(tooDeep.status).toBe(400);
  expect(expectedRevisionId).toBe(destinationRevisionId);

  const removedBranch = await send('removeDraftPoint', {
    expectedRevisionId,
    occurrenceId: deepIds[7],
  });
  expect(removedBranch.status).toBe(200);
  const afterRemovalRevisionId = removedBranch.value.revisionId as string;
  expectedRevisionId = afterRemovalRevisionId;

  const currentSnapshot = await readHostedDraftPointSnapshot(native.pool, catalogueId, afterRemovalRevisionId);
  expect(currentSnapshot).not.toBeNull();
  const repairedEmptyPart = await readHostedVersionOccurrence<{ kind: string; subtreeHeight: number }>(
    native.pool,
    currentSnapshot!,
    emptyPartId,
  );
  expect(repairedEmptyPart?.value.subtreeHeight).toBe(7);
  expect(await readHostedVersionOccurrence(native.pool, currentSnapshot!, deepIds[7]!)).toBeNull();

  const afterRemovalStart = observer.records.length;
  const newlyValid = await send('moveDraftPoint', {
    expectedRevisionId,
    occurrenceId: emptyPartId,
    parentId: destinations[7],
    beforeOccurrenceId: null,
  });
  expect(newlyValid.status).toBe(200);
  const atLimitRevisionId = newlyValid.value.revisionId as string;
  bounded(observer.records.slice(afterRemovalStart));
  expectedRevisionId = atLimitRevisionId;

  const trailingPartId = newOccurrenceId();
  const trailing = await send('insertDraftPoint', {
    expectedRevisionId,
    occurrenceId: trailingPartId,
    parentId: destinations[7],
    beforeOccurrenceId: null,
    title: 'Trailing sibling',
    placement: { kind: 'part' },
  });
  expect(trailing.status).toBe(200);
  expectedRevisionId = trailing.value.revisionId as string;

  const reorderStart = observer.records.length;
  const reordered = await send('moveDraftPoint', {
    expectedRevisionId,
    occurrenceId: emptyPartId,
    parentId: destinations[7],
    beforeOccurrenceId: null,
  });
  expect(reordered.status).toBe(200);
  bounded(observer.records.slice(reorderStart));

  const reorderedRevisionId = reordered.value.revisionId as string;
  const reorderedSnapshot = await readHostedDraftPointSnapshot(native.pool, catalogueId, reorderedRevisionId);
  expect(reorderedSnapshot).not.toBeNull();
  const siblingRoot = await readHostedVersionSiblingRoot(native.pool, reorderedSnapshot!, destinations[7]!);
  expect(siblingRoot).not.toBeNull();
  const indexWrite = createHostedVersionWrite<{ kind: string; subtreeHeight: number }>(native.pool, reorderedSnapshot!);
  const siblingIndex = hostedVersionSequence(indexWrite, 'sibling');
  const siblingSequenceRoot = await siblingIndex.readNode(siblingRoot!.rootNodeId!);
  expect(siblingSequenceRoot).not.toBeNull();
  const siblingOrder = [];
  for (let index = 0n; index < siblingSequenceRoot!.count; index += 1n) {
    siblingOrder.push((await selectVersionedOutlineSequenceNode(siblingIndex, siblingRoot!.rootNodeId, index))?.id);
  }
  expect(siblingOrder).toEqual([trailingPartId, emptyPartId]);

  const oldSnapshot = await readHostedDraftPointSnapshot(native.pool, catalogueId, underEmptyRevisionId);
  expect(oldSnapshot).not.toBeNull();
  expect(
    (await readHostedVersionOccurrence<{ subtreeHeight: number }>(native.pool, oldSnapshot!, emptyPartId))?.value
      .subtreeHeight,
  ).toBe(12);
  expect(await readHostedVersionOccurrence(native.pool, oldSnapshot!, deepIds[7]!)).not.toBeNull();
});
