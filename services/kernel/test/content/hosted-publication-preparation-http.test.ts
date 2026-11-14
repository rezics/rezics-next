import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { routeOf } from '../../src/route/route.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
const PREPARATION_CHANGED_EVENT = 'com.rezics.content.hosted-catalogue.preparation.changed.v1';

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

async function newBook() {
  const thread = await f.native.thread();
  const route = routeOf(thread.firstPost.id);
  if (route === null) throw new Error('Preparation fixture has no catalogue route');
  const book = {
    catalogueId: thread.firstPost.id,
    threadId: thread.id,
    newId: () => f.newOccurrenceIdFor(thread.firstPost.id),
  };
  const target = f.target(thread);
  const rootPart = book.newId();
  const childPart = book.newId();
  const nestedChapter = book.newId();
  const publicChapter = book.newId();
  const placements: HostedPlacement[] = [
    { occurrenceId: rootPart, parentId: null, position: 0, title: 'Part one', kind: 'part' },
    { occurrenceId: childPart, parentId: rootPart, position: 0, title: 'Nested part', kind: 'part' },
    {
      occurrenceId: nestedChapter,
      parentId: childPart,
      position: 0,
      title: 'Nested chapter',
      kind: 'chapter',
      target,
    },
    {
      occurrenceId: publicChapter,
      parentId: null,
      position: 1,
      title: 'Existing release A',
      kind: 'chapter',
      target,
    },
  ];
  const path = `/v1/hostedCatalogues/${book.catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: book.catalogueId,
    threadId: book.threadId,
    placements,
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [publicChapter],
    },
    200,
  );
  return { ...book, path, target, placements, rootPart, childPart, nestedChapter, publicChapter, created, published };
}

async function selectedRelease(catalogueId: string): Promise<string | null> {
  const row = (
    await f.native.pool.query<{ publication_id: string | null }>(
      'SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2',
      [routeOf(catalogueId), catalogueId],
    )
  ).rows[0];
  return row?.publication_id ?? null;
}

function prepPath(path: string, stageId: string): string {
  return `${path}/publicationPreparations/${stageId}`;
}

test('progress emits only for a persisted expiry transition and authorized receipt replay emits no duplicate', async () => {
  const book = await newBook();
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(started.status).toBe(202);
  const stageId = started.value.stageId as string, stagePath = prepPath(book.path, stageId);
  const eventCount = async () =>
    Number((await f.native.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM core.outbox WHERE subject=$1 AND type=$2',
      [book.catalogueId, PREPARATION_CHANGED_EVENT],
    )).rows[0]?.count ?? '0');
  const eventsBeforeProgress = await eventCount();
  expect(eventsBeforeProgress).toBeGreaterThan(0);

  const liveKey = crypto.randomUUID(), liveProgress = await f.native.call('POST', `${stagePath}:progress`, {}, { key: liveKey });
  expect(liveProgress.status).toBe(200);
  const liveReplay = await f.native.call('POST', `${stagePath}:progress`, {}, { key: liveKey });
  expect(liveReplay.value).toEqual(liveProgress.value);
  expect(await eventCount()).toBe(eventsBeforeProgress);

  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 second'
     WHERE catalogue_id=$1 AND stage_id=$2`,
    [book.catalogueId, stageId],
  );
  const expiryKey = crypto.randomUUID(), expired = await f.native.call('POST', `${stagePath}:progress`, {}, { key: expiryKey });
  expect(expired.status).toBe(200);
  expect(expired.value.stage.state).toBe('expired');
  expect(await eventCount()).toBe(eventsBeforeProgress + 1);
  expect((await f.native.call('POST', `${stagePath}:progress`, {}, { key: expiryKey })).value).toEqual(expired.value);
  expect((await f.native.call('POST', `${stagePath}:progress`, {}, { key: crypto.randomUUID() })).value.stage.state).toBe('expired');
  expect(await eventCount()).toBe(eventsBeforeProgress + 1);
});

test('mounted whole and nested selection builds complete private candidates with exact retry and resume', async () => {
  const book = await newBook();
  const startBody = {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  } as const;
  const startKey = crypto.randomUUID();
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, startBody, { key: startKey });
  expect(started.status).toBe(202);
  expect(started.value).toMatchObject({
    catalogueId: book.catalogueId,
    stage: { state: 'building', mode: 'whole', candidateCount: '0' },
    candidate: null,
    candidateReady: false,
  });
  const stageId = startBody.stageId;
  expect(started.value.stageId).toBe(stageId);
  const stagePath = prepPath(book.path, stageId);

  const wholeStepId = book.newId();
  const wholeStepKey = crypto.randomUUID();
  const wholeStep = await f.native.call('POST', `${stagePath}:advance`, { stepId: wholeStepId }, { key: wholeStepKey });
  expect(wholeStep.status).toBe(200);
  expect(wholeStep.value.stage).toMatchObject({ state: 'ready', sourceExhausted: true, candidateCount: '4' });
  const stageSeal = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(stageSeal.status).toBe(200);
  expect(stageSeal.value.stage.state).toBe('sealed');
  expect(stageSeal.value.candidate).toMatchObject({ coverageComplete: false, sealed: false });
  const candidatePage = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(candidatePage.status).toBe(200);
  expect(candidatePage.value.candidate).toMatchObject({ placementCount: '4', coverageComplete: true, sealed: false });
  const sealedCandidate = await f.native.call('POST', `${stagePath}:seal`, {});
  expect(sealedCandidate.status).toBe(200);
  expect(sealedCandidate.value).toMatchObject({
    stage: { state: 'sealed' },
    candidate: { placementCount: '4', rootCount: '2', chapterCount: '2', coverageComplete: true, sealed: true },
    candidateReady: true,
  });

  // Both command receipts replay their original result even after native progress moved on.
  const replayedStart = await f.native.call('POST', `${book.path}:prepareRelease`, startBody, { key: startKey });
  expect(replayedStart.status).toBe(202);
  expect(replayedStart.value).toEqual(started.value);
  const replayedStep = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: wholeStepId },
    { key: wholeStepKey },
  );
  expect(replayedStep.status).toBe(200);
  expect(replayedStep.value).toEqual(wholeStep.value);

  const selectedStartBody = {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'selection',
  } as const;
  const selectedStart = await f.native.call('POST', `${book.path}:prepareRelease`, selectedStartBody);
  expect(selectedStart.status).toBe(202);
  const selectedStage = prepPath(book.path, selectedStart.value.stageId as string);
  const firstBatchBody = { batchId: book.newId(), occurrenceIds: [book.rootPart, book.childPart] };
  const firstBatchKey = crypto.randomUUID();
  const firstBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: firstBatchKey,
  });
  expect(firstBatch.status).toBe(200);
  expect(firstBatch.value.batch).toMatchObject({ itemCount: 2, firstInputPosition: '0' });
  const secondBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, {
    batchId: book.newId(),
    occurrenceIds: [book.nestedChapter],
  });
  expect(secondBatch.status).toBe(200);
  const frozen = await f.native.call('POST', `${selectedStage}:freezeSelection`, {});
  expect(frozen.status).toBe(200);
  expect(frozen.value.stage).toMatchObject({ state: 'building', inputCount: '3' });

  const selectionStepId = book.newId();
  const selectionStepKey = crypto.randomUUID();
  const settled = await f.native.call(
    'POST',
    `${selectedStage}:advance`,
    { stepId: selectionStepId },
    { key: selectionStepKey },
  );
  expect(settled.status).toBe(200);
  expect(settled.value.stage.state).toBe('closing');
  const closed = await f.native.call('POST', `${selectedStage}:advance`, { stepId: book.newId() });
  expect(closed.status).toBe(200);
  expect(closed.value.stage.state).toBe('ready');
  const selectedSeal = await f.native.call('POST', `${selectedStage}:seal`, {});
  expect(selectedSeal.status).toBe(200);
  expect(selectedSeal.value.stage.state).toBe('sealed');
  const selectedPage = await f.native.call('POST', `${selectedStage}:advance`, { stepId: book.newId() });
  expect(selectedPage.status).toBe(200);
  expect(selectedPage.value.candidate).toMatchObject({ placementCount: '3', coverageComplete: true });
  const selectedCandidate = await f.native.call('POST', `${selectedStage}:seal`, {});
  expect(selectedCandidate.status).toBe(200);
  expect(selectedCandidate.value).toMatchObject({
    candidate: { placementCount: '3', sealed: true },
    candidateReady: true,
  });

  const replayedBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: firstBatchKey,
  });
  expect(replayedBatch.status).toBe(200);
  expect(replayedBatch.value).toEqual(firstBatch.value);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
});

test('selection progress exposes only its pinned binding and rejects new batches after either pointer changes', async () => {
  const draftBook = await newBook();
  const draftStart = await f.native.call('POST', `${draftBook.path}:prepareRelease`, {
    stageId: draftBook.newId(),
    expectedRevisionId: draftBook.created.revisionId,
    expectedPublicationId: draftBook.published.revisionId,
    mode: 'selection',
  });
  expect(draftStart.status).toBe(202);
  expect(draftStart.value.stage).toMatchObject({
    sourceRevisionId: draftBook.created.revisionId,
    expectedHeadRevisionId: draftBook.created.revisionId,
    expectedPublicationId: draftBook.published.revisionId,
  });
  const draftStageId = draftStart.value.stageId as string;
  const draftStage = prepPath(draftBook.path, draftStageId);
  const firstBody = { batchId: draftBook.newId(), occurrenceIds: [draftBook.rootPart] };
  const firstKey = crypto.randomUUID();
  const firstBatch = await f.native.call('POST', `${draftStage}:appendSelectionBatch`, firstBody, { key: firstKey });
  expect(firstBatch.status).toBe(200);

  const revised = await f.native.call('POST', `${draftBook.path}:appendRootChapter`, {
    expectedRevisionId: draftBook.created.revisionId,
    occurrenceId: draftBook.newId(),
    title: 'A later draft edit',
    target: draftBook.target,
  });
  expect(revised.status).toBe(200);
  const replayed = await f.native.call('POST', `${draftStage}:appendSelectionBatch`, firstBody, { key: firstKey });
  expect(replayed.status).toBe(200);
  expect(replayed.value).toEqual(firstBatch.value);

  const blockedDraftBatch = await f.native.call('POST', `${draftStage}:appendSelectionBatch`, {
    batchId: draftBook.newId(),
    occurrenceIds: [draftBook.childPart],
  });
  expect(blockedDraftBatch.status).toBe(412);
  const draftProgress = await f.native.call('POST', `${draftStage}:progress`, {});
  expect(draftProgress.value.stage).toMatchObject({
    inputCount: '1',
    sourceRevisionId: draftBook.created.revisionId,
    expectedHeadRevisionId: draftBook.created.revisionId,
    expectedPublicationId: draftBook.published.revisionId,
  });

  const releaseBook = await newBook();
  const releaseStart = await f.native.call('POST', `${releaseBook.path}:prepareRelease`, {
    stageId: releaseBook.newId(),
    expectedRevisionId: releaseBook.created.revisionId,
    expectedPublicationId: releaseBook.published.revisionId,
    mode: 'selection',
  });
  expect(releaseStart.status).toBe(202);
  const releaseStage = prepPath(releaseBook.path, releaseStart.value.stageId as string);
  const changedRelease = await f.native.call('POST', `${releaseBook.path}:publish`, {
    expectedRevisionId: releaseBook.created.revisionId,
    expectedPublicationId: releaseBook.published.revisionId,
    occurrenceIds: [releaseBook.nestedChapter],
  });
  expect(changedRelease.status).toBe(200);
  const blockedReleaseBatch = await f.native.call('POST', `${releaseStage}:appendSelectionBatch`, {
    batchId: releaseBook.newId(),
    occurrenceIds: [releaseBook.rootPart],
  });
  expect(blockedReleaseBatch.status).toBe(412);
  const releaseProgress = await f.native.call('POST', `${releaseStage}:progress`, {});
  expect(releaseProgress.value.stage).toMatchObject({
    inputCount: '0',
    sourceRevisionId: releaseBook.created.revisionId,
    expectedHeadRevisionId: releaseBook.created.revisionId,
    expectedPublicationId: releaseBook.published.revisionId,
  });
});

test('mounted boundary rejects malformed batches and non-authors; cancel and stale intents keep A selected', async () => {
  const book = await newBook();
  const start = (mode: 'whole' | 'selection' = 'whole') =>
    f.native.call('POST', `${book.path}:prepareRelease`, {
      stageId: book.newId(),
      expectedRevisionId: book.created.revisionId,
      expectedPublicationId: book.published.revisionId,
      mode,
    });

  const cancelledStart = await start();
  expect(cancelledStart.status).toBe(202);
  const cancelledPath = prepPath(book.path, cancelledStart.value.stageId as string);
  const denied = await f.native.call('POST', `${cancelledPath}:progress`, {}, { other: true });
  expect(denied.status).toBe(403);
  const malformed = await f.native.call('POST', `${cancelledPath}:appendSelectionBatch`, {
    batchId: book.newId(),
    occurrenceIds: Array.from({ length: 513 }, () => book.newId()),
  });
  expect(malformed.status).toBe(400);
  const cancelled = await f.native.call('POST', `${cancelledPath}:cancel`, {});
  expect(cancelled.status).toBe(200);
  expect(cancelled.value.stage.state).toBe('cancelled');
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const staleHead = await f.native.call('POST', `${book.path}:appendRootChapter`, {
    expectedRevisionId: book.created.revisionId,
    occurrenceId: book.newId(),
    title: 'A later draft edit',
    target: book.target,
  });
  expect(staleHead.status).toBe(200);
  const staleStart = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(staleStart.status).toBe(412);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const duplicateStart = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: staleHead.value.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'selection',
  });
  expect(duplicateStart.status).toBe(202);
  const duplicatePath = prepPath(book.path, duplicateStart.value.stageId as string);
  const unknown = book.newId();
  const duplicateBatch = await f.native.call('POST', `${duplicatePath}:appendSelectionBatch`, {
    batchId: book.newId(),
    occurrenceIds: [book.rootPart, book.rootPart, unknown],
  });
  expect(duplicateBatch.status).toBe(200);
  expect((await f.native.call('POST', `${duplicatePath}:freezeSelection`, {})).status).toBe(200);
  const failed = await f.native.call('POST', `${duplicatePath}:advance`, { stepId: book.newId() });
  expect(failed.status).toBe(200);
  expect(failed.value.stage).toMatchObject({ state: 'failed', failure: 'selection_invalid' });

  const epochBoundStartBody = {
    stageId: book.newId(),
    expectedRevisionId: staleHead.value.revisionId as string,
    expectedPublicationId: book.published.revisionId as string,
    mode: 'whole',
  } as const;
  const epochBoundKey = crypto.randomUUID();
  const epochBoundStart = await f.native.call('POST', `${book.path}:prepareRelease`, epochBoundStartBody, {
    key: epochBoundKey,
  });
  expect(epochBoundStart.status).toBe(202);
  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET owner_epoch=owner_epoch+1
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(book.catalogueId), book.catalogueId, epochBoundStartBody.stageId],
  );
  const wrongEpochReplay = await f.native.call('POST', `${book.path}:prepareRelease`, epochBoundStartBody, {
    key: epochBoundKey,
  });
  expect(wrongEpochReplay.status).toBe(404);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
});
