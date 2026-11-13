import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { routeOf } from '../../src/route/route.ts';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { DurableInitiatorUnavailableError } from '../../src/access/contract/index.ts';
import { createHostedPublicationPreparationAuthority } from '../../src/content/hosted-publication-preparation-initiator.ts';
import {
  executeHostedPublicationPreparationPage,
  type HostedPublicationPreparationWorkOptions,
} from '../../src/content/hosted-publication-preparation-work.ts';
import {
  HOSTED_PUBLICATION_PREPARATION_WORK_EVENT,
  type HostedPublicationPreparationWorkInput,
} from '../../src/content/work-contract.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;

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

function workerPorts() {
  const consent = createCurrentConsentReader({ database: f.native.system.database.authPool });
  const options: HostedPublicationPreparationWorkOptions = {
    access: f.native.system.access,
    readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    routeKey: f.native.system.routeKey,
    now: () => Date.now(),
  };
  const context = { pool: f.native.pool, clock: () => new Date() };
  const authority = createHostedPublicationPreparationAuthority({
    pool: context.pool,
    access: options.access,
    readConsent: options.readConsent,
  });
  return { context, options, authority };
}

async function preparationWorkInputs(catalogueId: string): Promise<HostedPublicationPreparationWorkInput[]> {
  const work = await f.native.pool.query<{ data: HostedPublicationPreparationWorkInput }>(
    'SELECT data FROM core.outbox WHERE type=$1 AND subject=$2 ORDER BY position,event_seq',
    [HOSTED_PUBLICATION_PREPARATION_WORK_EVENT, catalogueId],
  );
  return work.rows.map((row) => row.data);
}

async function newSelectionBook(size: number) {
  const thread = await f.native.thread();
  const route = routeOf(thread.firstPost.id);
  if (route === null) throw new Error('Preparation fixture has no catalogue route');
  const catalogueId = thread.firstPost.id;
  const target = f.target(thread);
  const placements: HostedPlacement[] = Array.from({ length: size }, (_, position) => ({
    occurrenceId: f.newOccurrenceIdFor(catalogueId),
    parentId: null,
    position,
    title: `Chapter ${position + 1}`,
    kind: 'chapter',
    target,
  }));
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: thread.id,
    placements,
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [placements[0]!.occurrenceId],
    },
    200,
  );
  return { catalogueId, path, placements, created, published };
}

test('frozen selection continues from committed pages after worker restart and stops on owner-epoch change', async () => {
  const book = await newSelectionBook(41);
  const stageId = f.newOccurrenceIdFor(book.catalogueId);
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId,
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'selection',
  });
  expect(started.status).toBe(202);
  let clientRequests = 1;
  const stagePath = prepPath(book.path, stageId);
  const batch = await f.native.call('POST', `${stagePath}:appendSelectionBatch`, {
    batchId: f.newOccurrenceIdFor(book.catalogueId),
    occurrenceIds: book.placements.map((item) => item.occurrenceId),
  });
  clientRequests++;
  expect(batch.status).toBe(200);
  const frozen = await f.native.call('POST', `${stagePath}:freezeSelection`, {});
  clientRequests++;
  expect(frozen.status).toBe(200);

  const seen = new Set<string>();
  const firstInput = (await preparationWorkInputs(book.catalogueId))[0];
  expect(firstInput).toBeDefined();
  const firstPorts = workerPorts();
  const first = await executeHostedPublicationPreparationPage(
    firstInput!,
    firstPorts.context,
    firstPorts.options,
    firstPorts.authority,
  );
  seen.add(firstInput!.stepId);
  expect(first.stage).toMatchObject({ state: 'building', settledInputCount: '20' });

  // A replacement worker reconstructs only its trusted ports and resumes the
  // committed frontier from the ID-only continuation in the native outbox.
  const resumedPorts = workerPorts();
  let pending = (await preparationWorkInputs(book.catalogueId)).find((item) => !seen.has(item.stepId));
  expect(pending).toBeDefined();
  const second = await executeHostedPublicationPreparationPage(
    pending!,
    resumedPorts.context,
    resumedPorts.options,
    resumedPorts.authority,
  );
  seen.add(pending!.stepId);
  expect(second.stage).toMatchObject({ state: 'building', settledInputCount: '40' });

  let final = second;
  const candidatePageSizes: number[] = [];
  let candidateCount = 0;
  for (let page = 0; page < 20; page++) {
    pending = (await preparationWorkInputs(book.catalogueId)).find((item) => !seen.has(item.stepId));
    if (!pending) break;
    final = await executeHostedPublicationPreparationPage(
      pending,
      resumedPorts.context,
      resumedPorts.options,
      resumedPorts.authority,
    );
    seen.add(pending.stepId);
    const nextCandidateCount = Number(final.candidate?.placementCount ?? 0);
    if (nextCandidateCount > candidateCount) candidatePageSizes.push(nextCandidateCount - candidateCount);
    candidateCount = nextCandidateCount;
  }
  expect(final).toMatchObject({
    stage: { state: 'sealed' },
    candidate: { placementCount: '41', coverageComplete: true, sealed: true },
    candidateReady: true,
  });
  expect(candidatePageSizes.reduce((sum, count) => sum + count, 0)).toBe(41);
  expect(candidatePageSizes.every((count) => count <= 20)).toBe(true);
  const committedSelectionPages = await f.native.pool.query<{ processed: string }>(
    `SELECT processed::text FROM content.hosted_publication_staging_step
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND phase='selection' ORDER BY from_frontier`,
    [routeOf(book.catalogueId), book.catalogueId, stageId],
  );
  expect(committedSelectionPages.rows.map((row) => Number(row.processed))).toEqual([20, 20, 1]);
  expect(clientRequests).toBe(3);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const changedBook = await newSelectionBook(1);
  const changedStageId = f.newOccurrenceIdFor(changedBook.catalogueId);
  const changedStart = await f.native.call('POST', `${changedBook.path}:prepareRelease`, {
    stageId: changedStageId,
    expectedRevisionId: changedBook.created.revisionId,
    expectedPublicationId: changedBook.published.revisionId,
    mode: 'whole',
  });
  expect(changedStart.status).toBe(202);
  const changedInput = (await preparationWorkInputs(changedBook.catalogueId))[0];
  expect(changedInput).toBeDefined();
  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET owner_epoch=owner_epoch+1
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(changedBook.catalogueId), changedBook.catalogueId, changedStageId],
  );
  const changedPorts = workerPorts();
  await expect(
    executeHostedPublicationPreparationPage(
      changedInput!,
      changedPorts.context,
      changedPorts.options,
      changedPorts.authority,
    ),
  ).rejects.toBeInstanceOf(DurableInitiatorUnavailableError);
  const unchangedStage = await f.native.pool.query<{ candidate_count: string; status: string }>(
    `SELECT candidate_count::text,status FROM content.hosted_publication_staging
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(changedBook.catalogueId), changedBook.catalogueId, changedStageId],
  );
  expect(unchangedStage.rows[0]).toEqual({ candidate_count: '0', status: 'building' });
  expect(await selectedRelease(changedBook.catalogueId)).toBe(changedBook.published.revisionId);
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
    durableInitiator: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const stageId = startBody.stageId;
  expect(started.value.stageId).toBe(stageId);
  const work = await f.native.pool.query<{ data: Record<string, unknown> }>(
    'SELECT data FROM core.outbox WHERE type=$1 AND subject=$2 ORDER BY position,event_seq',
    [HOSTED_PUBLICATION_PREPARATION_WORK_EVENT, book.catalogueId],
  );
  expect(work.rows).toHaveLength(1);
  expect(Object.keys(work.rows[0]!.data).sort()).toEqual(['catalogueId', 'commandKey', 'stageId', 'stepId']);
  expect(work.rows[0]!.data).toMatchObject({ catalogueId: book.catalogueId, stageId });
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
  expect((await f.native.call('POST', `${releaseStage}:freezeSelection`, {})).status).toBe(200);
  const stopped = await f.native.call('POST', `${releaseStage}:advance`, { stepId: releaseBook.newId() });
  expect(stopped.value.stage).toMatchObject({ state: 'failed', failure: 'stale_source' });
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
  const retainedAuthority = await f.native.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM content.hosted_publication_preparation_authority
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [routeOf(book.catalogueId), book.catalogueId, cancelledStart.value.stageId],
  );
  expect(retainedAuthority.rows[0]?.count).toBe('0');
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
