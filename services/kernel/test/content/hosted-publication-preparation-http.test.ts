import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { newId, ROUTES, routeOf } from '../../src/route/route.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
const PREPARATION_CHANGED_EVENT = 'com.rezics.content.hosted-catalogue.preparation.changed.v1';

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

async function newBook(additionalRootChapters = 0) {
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
    ...Array.from({ length: additionalRootChapters }, (_, index) => ({
      occurrenceId: book.newId(),
      parentId: null,
      position: index + 2,
      title: `Additional chapter ${index + 1}`,
      kind: 'chapter' as const,
      target,
    })),
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

async function preparationEventCount(catalogueId: string): Promise<number> {
  return Number(
    (
      await f.native.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM core.outbox WHERE subject=$1 AND type=$2',
        [catalogueId, PREPARATION_CHANGED_EVENT],
      )
    ).rows[0]?.count ?? '0',
  );
}

async function withFixedDateNow<T>(instant: number, work: () => Promise<T>): Promise<T> {
  const current = Date.now;
  Date.now = () => instant;
  try {
    return await work();
  } finally {
    Date.now = current;
  }
}

async function waitForBlockedStageRow(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const waiting = await f.native.pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock'
         AND $1=ANY(pg_blocking_pids(pid))
         AND query ILIKE '%content.hosted_publication_staging%'
         AND query ILIKE '%FOR UPDATE%'`,
      [blockerPid],
    );
    if (waiting.rowCount) return;
    await Bun.sleep(5);
  }
  throw new Error('Fresh preparation did not wait on the retained stage row');
}

test('fresh prepare waits on an existing stage before acquiring the catalogue lock', async () => {
  const book = await newBook();
  const input = {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  } as const;
  const first = await f.native.call('POST', `${book.path}:prepareRelease`, input);
  expect(first.status).toBe(202);

  const route = routeOf(book.catalogueId)!;
  const readStage = () =>
    f.native.pool.query(
      `SELECT (SELECT count(*)::text FROM content.hosted_publication_staging
               WHERE route=$1 AND catalogue_id=$2) AS retained_count,
              source_revision_id,expected_head_revision_id,expected_publication_id,mode,status,
              to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
       FROM content.hosted_publication_staging
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, book.catalogueId, input.stageId],
    );
  const retainedBefore = await readStage();
  expect(retainedBefore.rows).toHaveLength(1);

  const held = await f.native.pool.connect();
  await held.query('BEGIN');
  const blockerPid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let catalogueLockAcquired = false;
  let repeated: Promise<{ value: Awaited<ReturnType<typeof f.native.call>> } | { error: unknown }> | undefined;
  try {
    await held.query(
      `SELECT 1 FROM content.hosted_publication_staging
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 FOR UPDATE`,
      [route, book.catalogueId, input.stageId],
    );
    repeated = f.native.call('POST', `${book.path}:prepareRelease`, input, { key: crypto.randomUUID() }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForBlockedStageRow(blockerPid);

    const probe = await f.native.pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(`SELECT 1 FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2 FOR UPDATE NOWAIT`, [
        route,
        book.catalogueId,
      ]);
      catalogueLockAcquired = true;
    } catch {
      await probe.query('ROLLBACK').catch(() => {});
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
  } finally {
    await held.query('ROLLBACK').catch(() => {});
    held.release();
    if (repeated) await repeated;
  }

  if (!repeated) throw new Error('Fresh preparation was not submitted');
  const retry = await repeated;
  if ('error' in retry) throw retry.error;
  expect(catalogueLockAcquired).toBe(true);
  expect(retry.value.status).toBe(412);
  expect((await readStage()).rows).toEqual(retainedBefore.rows);
});

test('progress emits only for a persisted expiry transition and authorized receipt replay emits no duplicate', async () => {
  const book = await newBook();
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(started.status).toBe(202);
  const stageId = started.value.stageId as string,
    stagePath = prepPath(book.path, stageId);
  const eventsBeforeProgress = await preparationEventCount(book.catalogueId);
  expect(eventsBeforeProgress).toBeGreaterThan(0);

  const liveKey = crypto.randomUUID(),
    liveProgress = await f.native.call('POST', `${stagePath}:progress`, {}, { key: liveKey });
  expect(liveProgress.status).toBe(200);
  const liveReplay = await f.native.call('POST', `${stagePath}:progress`, {}, { key: liveKey });
  expect(liveReplay.value).toEqual(liveProgress.value);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeProgress);

  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 second'
     WHERE catalogue_id=$1 AND stage_id=$2`,
    [book.catalogueId, stageId],
  );
  const expiryKey = crypto.randomUUID(),
    expired = await f.native.call('POST', `${stagePath}:progress`, {}, { key: expiryKey });
  expect(expired.status).toBe(200);
  expect(expired.value.stage.state).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeProgress + 1);
  expect((await f.native.call('POST', `${stagePath}:progress`, {}, { key: expiryKey })).value).toEqual(expired.value);
  expect(
    (await f.native.call('POST', `${stagePath}:progress`, {}, { key: crypto.randomUUID() })).value.stage.state,
  ).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeProgress + 1);
});

test('Freeze emits once for the first input version and not for exact or fresh-key retries', async () => {
  const book = await newBook();
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'selection',
  });
  expect(started.status).toBe(202);
  const stageId = started.value.stageId as string;
  const stagePath = prepPath(book.path, stageId);
  const appended = await f.native.call('POST', `${stagePath}:appendSelectionBatch`, {
    batchId: book.newId(),
    occurrenceIds: [book.publicChapter],
  });
  expect(appended.status).toBe(200);

  const eventsBeforeFreeze = await preparationEventCount(book.catalogueId);
  const freezeKey = crypto.randomUUID();
  const frozen = await f.native.call('POST', `${stagePath}:freezeSelection`, {}, { key: freezeKey });
  expect(frozen.status).toBe(200);
  expect(frozen.value).toMatchObject({
    catalogueId: book.catalogueId,
    stageId,
    stage: { state: 'building', mode: 'selection', inputCount: '1' },
    candidate: null,
    candidateReady: false,
  });
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeFreeze + 1);

  const replayed = await f.native.call('POST', `${stagePath}:freezeSelection`, {}, { key: freezeKey });
  expect(replayed.status).toBe(200);
  expect(replayed.value).toEqual(frozen.value);

  const freshKeyRetry = await f.native.call('POST', `${stagePath}:freezeSelection`, {}, { key: crypto.randomUUID() });
  expect(freshKeyRetry.status).toBe(200);
  expect(freshKeyRetry.value).toEqual(frozen.value);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeFreeze + 1);
});

test('mounted whole and nested selection builds complete private candidates with exact retry and resume', async () => {
  const book = await newBook(37);
  const startBody = {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  } as const;
  const startKey = crypto.randomUUID();
  let events = await preparationEventCount(book.catalogueId);
  const [started, eventsAfterStart, freshStartReplay] = await withFixedDateNow(
    Date.now(),
    async () =>
      [
        await f.native.call('POST', `${book.path}:prepareRelease`, startBody, { key: startKey }),
        await preparationEventCount(book.catalogueId),
        await f.native.call('POST', `${book.path}:prepareRelease`, startBody, { key: crypto.randomUUID() }),
      ] as const,
  );
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
  expect(eventsAfterStart).toBe(++events);
  expect([freshStartReplay.value, await preparationEventCount(book.catalogueId)]).toEqual([started.value, events]);
  const wrongRouteStepId = newId((routeOf(book.catalogueId)! + 1) % ROUTES);
  const retainedCounts = async (retainedStageId: string) =>
    (
      await f.native.pool.query<{
        candidates: string;
        nativeSteps: string;
        advanceReceipts: string;
        candidatePages: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM content.hosted_publication_staging_candidate
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidates,
           (SELECT count(*)::text FROM content.hosted_publication_staging_step
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS "nativeSteps",
           (SELECT count(*)::text FROM content.hosted_publication_staging_step
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND result_preparation IS NOT NULL)
            AS "advanceReceipts",
           (SELECT count(*)::text FROM content.hosted_version_release_candidate_page
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS "candidatePages"`,
        [routeOf(book.catalogueId), book.catalogueId, retainedStageId],
      )
    ).rows[0];

  const wholeStepId = book.newId();
  const wholeStepKey = crypto.randomUUID();
  const wholeStep = await f.native.call('POST', `${stagePath}:advance`, { stepId: wholeStepId }, { key: wholeStepKey });
  expect(wholeStep.status).toBe(200);
  expect(wholeStep.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });
  const savedWholeCheckpoint = await f.native.pool.query<{ result_checkpoint: unknown }>(
    `SELECT result_checkpoint FROM content.hosted_publication_staging_step
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND step_id=$4`,
    [routeOf(book.catalogueId), book.catalogueId, stageId, wholeStepId],
  );
  expect(savedWholeCheckpoint.rows[0]?.result_checkpoint).toEqual(wholeStep.value.stage);
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const freshStepReplay = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: wholeStepId },
    { key: crypto.randomUUID() },
  );
  expect([freshStepReplay.value, await preparationEventCount(book.catalogueId)]).toEqual([wholeStep.value, events]);
  const sourceMiddle = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(sourceMiddle.value.stage).toMatchObject({ state: 'building', sourceFrontier: '39', candidateCount: '40' });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const lastSourceStepId = book.newId();
  const sourceRemainder = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: lastSourceStepId },
    { key: crypto.randomUUID() },
  );
  expect(sourceRemainder.value.stage).toMatchObject({ state: 'ready', sourceExhausted: true, candidateCount: '41' });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const afterLastSource = await retainedCounts(stageId);
  const lastSourceReplay = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: lastSourceStepId },
    { key: crypto.randomUUID() },
  );
  expect(lastSourceReplay.value).toEqual(sourceRemainder.value);
  expect(await retainedCounts(stageId)).toEqual(afterLastSource);
  expect(await preparationEventCount(book.catalogueId)).toBe(events);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
  const wrongMaterialization = await f.native.call('POST', `${stagePath}:advance`, { stepId: wrongRouteStepId });
  expect(wrongMaterialization.status).toBe(412);

  const candidateBeginStepId = book.newId();
  const stageSeal = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: candidateBeginStepId },
    { key: crypto.randomUUID() },
  );
  expect(stageSeal.status).toBe(200);
  expect(stageSeal.value.stage.state).toBe('sealed');
  expect(stageSeal.value.candidate).toMatchObject({ coverageComplete: false, sealed: false });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const wrongPage = await f.native.call('POST', `${stagePath}:advance`, { stepId: wrongRouteStepId });
  expect(wrongPage.status).toBe(412);
  const beforeCandidatePage = await f.native.call('POST', `${stagePath}:progress`, {});
  expect(beforeCandidatePage.value.candidate).toMatchObject({ placementCount: '0', coverageComplete: false });
  const firstCandidatePageStepId = book.newId();
  const firstCandidatePage = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: firstCandidatePageStepId },
    { key: crypto.randomUUID() },
  );
  expect(firstCandidatePage.status).toBe(200);
  expect(firstCandidatePage.value.candidate).toMatchObject({ placementCount: '20', coverageComplete: false });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const secondCandidatePage = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(secondCandidatePage.status).toBe(200);
  expect(secondCandidatePage.value.candidate).toMatchObject({ placementCount: '40', coverageComplete: false });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);

  const beforeCandidateReplays = await retainedCounts(stageId);
  const beforeCandidateReplayEvents = await preparationEventCount(book.catalogueId);
  const previousRelease = await selectedRelease(book.catalogueId);
  const candidateBeginReplay = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: candidateBeginStepId },
    { key: crypto.randomUUID() },
  );
  const firstCandidatePageReplay = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: firstCandidatePageStepId },
    { key: crypto.randomUUID() },
  );
  expect(candidateBeginReplay.value).toEqual(stageSeal.value);
  expect(firstCandidatePageReplay.value).toEqual(firstCandidatePage.value);
  expect(await retainedCounts(stageId)).toEqual(beforeCandidateReplays);
  expect(await preparationEventCount(book.catalogueId)).toBe(beforeCandidateReplayEvents);
  expect(previousRelease).toBe(book.published.revisionId);
  expect(await selectedRelease(book.catalogueId)).toBe(previousRelease);

  const thirdCandidatePage = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(thirdCandidatePage.status).toBe(200);
  expect(thirdCandidatePage.value.candidate).toMatchObject({ placementCount: '41', coverageComplete: true });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const exhaustedStepId = book.newId();
  const exhaustedAdvance = await f.native.call('POST', `${stagePath}:advance`, { stepId: exhaustedStepId });
  expect(exhaustedAdvance.value.candidate).toMatchObject({ placementCount: '41', coverageComplete: true });
  expect(await preparationEventCount(book.catalogueId)).toBe(events);
  const afterExhaustedAdvance = await retainedCounts(stageId);
  const exhaustedReplay = await f.native.call(
    'POST',
    `${stagePath}:advance`,
    { stepId: exhaustedStepId },
    { key: crypto.randomUUID() },
  );
  expect(exhaustedReplay.value).toEqual(exhaustedAdvance.value);
  expect(await retainedCounts(stageId)).toEqual(afterExhaustedAdvance);
  expect(await preparationEventCount(book.catalogueId)).toBe(events);
  const sealedCandidate = await f.native.call('POST', `${stagePath}:seal`, {});
  expect(sealedCandidate.status).toBe(200);
  expect(sealedCandidate.value).toMatchObject({
    stage: { state: 'sealed' },
    candidate: { placementCount: '41', rootCount: '39', chapterCount: '39', coverageComplete: true, sealed: true },
    candidateReady: true,
  });
  expect(await preparationEventCount(book.catalogueId)).toBe(++events);
  const freshSealReplay = await f.native.call('POST', `${stagePath}:seal`, {}, { key: crypto.randomUUID() });
  expect([freshSealReplay.value, await preparationEventCount(book.catalogueId)]).toEqual([
    sealedCandidate.value,
    events,
  ]);

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

  const secondStageStartBody = {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  } as const;
  const secondStageStart = await f.native.call('POST', `${book.path}:prepareRelease`, secondStageStartBody);
  expect(secondStageStart.status).toBe(202);
  const secondStagePath = prepPath(book.path, secondStageStartBody.stageId);
  const foreignStageStep = await f.native.call(
    'POST',
    `${secondStagePath}:advance`,
    { stepId: wholeStepId },
    { key: crypto.randomUUID() },
  );
  expect(foreignStageStep.status).toBe(200);
  expect(foreignStageStep.value).toMatchObject({
    stageId: secondStageStartBody.stageId,
    stage: { state: 'building', candidateCount: '20' },
  });

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
  const eventsBeforeBatch = await preparationEventCount(book.catalogueId);
  const firstBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: firstBatchKey,
  });
  expect(firstBatch.status).toBe(200);
  expect(firstBatch.value.batch).toMatchObject({ itemCount: 2, firstInputPosition: '0' });
  const eventsAfterBatch = await preparationEventCount(book.catalogueId);
  expect(eventsAfterBatch).toBe(eventsBeforeBatch + 1);

  const replayedBatchWithFreshReceipt = await f.native.call(
    'POST',
    `${selectedStage}:appendSelectionBatch`,
    firstBatchBody,
    { key: crypto.randomUUID() },
  );
  expect(replayedBatchWithFreshReceipt.status).toBe(200);
  expect(replayedBatchWithFreshReceipt.value.batch.replayed).toBe(true);
  expect(replayedBatchWithFreshReceipt.value.stage.inputCount).toBe(firstBatch.value.stage.inputCount);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsAfterBatch);

  const mismatchedBatchReplay = await f.native.call(
    'POST',
    `${selectedStage}:appendSelectionBatch`,
    { ...firstBatchBody, occurrenceIds: [book.rootPart] },
    { key: crypto.randomUUID() },
  );
  expect(mismatchedBatchReplay.status).toBe(412);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsAfterBatch);

  const secondBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, {
    batchId: book.newId(),
    occurrenceIds: [book.nestedChapter],
  });
  expect(secondBatch.status).toBe(200);
  const freezeKey = crypto.randomUUID();
  const frozen = await f.native.call('POST', `${selectedStage}:freezeSelection`, {}, { key: freezeKey });
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

  const revisedDraft = await f.native.call('POST', `${book.path}:appendRootChapter`, {
    expectedRevisionId: book.created.revisionId,
    occurrenceId: book.newId(),
    title: 'A later draft edit',
    target: book.target,
  });
  expect(revisedDraft.status).toBe(200);
  const frozenNoOp = await f.native.call('POST', `${selectedStage}:freezeSelection`, {}, { key: crypto.randomUUID() });
  expect(frozenNoOp.status).toBe(200);
  expect(frozenNoOp.value.stage.state).toBe('sealed');

  const eventsBeforeExpiryReplay = await preparationEventCount(book.catalogueId);
  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 second'
     WHERE catalogue_id=$1 AND stage_id=$2`,
    [book.catalogueId, selectedStart.value.stageId],
  );
  const expiryReplay = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: crypto.randomUUID(),
  });
  expect(expiryReplay.status).toBe(200);
  expect(expiryReplay.value.stage.state).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeExpiryReplay + 1);

  const retainedExpiryReplay = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: crypto.randomUUID(),
  });
  expect(retainedExpiryReplay.value.stage.state).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeExpiryReplay + 1);

  const replayedBatch = await f.native.call('POST', `${selectedStage}:appendSelectionBatch`, firstBatchBody, {
    key: firstBatchKey,
  });
  expect(replayedBatch.status).toBe(200);
  expect(replayedBatch.value).toEqual(firstBatch.value);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeExpiryReplay + 1);
  const eventsBeforeFreezeReplay = await preparationEventCount(book.catalogueId);
  const replayedFreeze = await f.native.call('POST', `${selectedStage}:freezeSelection`, {}, { key: freezeKey });
  expect(replayedFreeze.status).toBe(200);
  expect(replayedFreeze.value).toEqual(frozen.value);
  expect(await preparationEventCount(book.catalogueId)).toBe(eventsBeforeFreezeReplay);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
});

test('Advance emits when its locked observation persists stage expiry', async () => {
  const book = await newBook();
  const start = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 hour' WHERE catalogue_id=$1 AND stage_id=$2`,
    [book.catalogueId, start.value.stageId],
  );
  const before = await preparationEventCount(book.catalogueId);
  const expired = await f.native.call('POST', `${prepPath(book.path, start.value.stageId as string)}:advance`, {
    stepId: book.newId(),
  });
  expect(expired.value.stage.state).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(before + 1);
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
  const draftBatchEvents = await preparationEventCount(draftBook.catalogueId);

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
  const freshReceiptReplay = await f.native.call('POST', `${draftStage}:appendSelectionBatch`, firstBody, {
    key: crypto.randomUUID(),
  });
  expect(freshReceiptReplay.status).toBe(200);
  expect(freshReceiptReplay.value.batch.replayed).toBe(true);
  expect(freshReceiptReplay.value.stage.inputCount).toBe('1');
  expect(await preparationEventCount(draftBook.catalogueId)).toBe(draftBatchEvents);

  const blockedDraftBatch = await f.native.call('POST', `${draftStage}:appendSelectionBatch`, {
    batchId: draftBook.newId(),
    occurrenceIds: [draftBook.childPart],
  });
  expect(blockedDraftBatch.status).toBe(412);
  const blockedDraftFreeze = await f.native.call('POST', `${draftStage}:freezeSelection`, {});
  expect(blockedDraftFreeze.status).toBe(412);
  const draftProgress = await f.native.call('POST', `${draftStage}:progress`, {});
  expect(draftProgress.value.stage).toMatchObject({
    state: 'collecting',
    inputVersion: '1',
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
  const releaseBatchBody = { batchId: releaseBook.newId(), occurrenceIds: [releaseBook.rootPart] };
  const releaseBatch = await f.native.call('POST', `${releaseStage}:appendSelectionBatch`, releaseBatchBody, {
    key: crypto.randomUUID(),
  });
  expect(releaseBatch.status).toBe(200);
  const releaseBatchEvents = await preparationEventCount(releaseBook.catalogueId);
  const changedRelease = await f.native.call('POST', `${releaseBook.path}:publish`, {
    expectedRevisionId: releaseBook.created.revisionId,
    expectedPublicationId: releaseBook.published.revisionId,
    occurrenceIds: [releaseBook.nestedChapter],
  });
  expect(changedRelease.status).toBe(200);
  const replayedReleaseBatch = await f.native.call('POST', `${releaseStage}:appendSelectionBatch`, releaseBatchBody, {
    key: crypto.randomUUID(),
  });
  expect(replayedReleaseBatch.status).toBe(200);
  expect(replayedReleaseBatch.value.batch.replayed).toBe(true);
  expect(replayedReleaseBatch.value.stage.inputCount).toBe('1');
  expect(await preparationEventCount(releaseBook.catalogueId)).toBe(releaseBatchEvents);
  const blockedReleaseBatch = await f.native.call('POST', `${releaseStage}:appendSelectionBatch`, {
    batchId: releaseBook.newId(),
    occurrenceIds: [releaseBook.rootPart],
  });
  expect(blockedReleaseBatch.status).toBe(412);
  const blockedReleaseFreeze = await f.native.call('POST', `${releaseStage}:freezeSelection`, {});
  expect(blockedReleaseFreeze.status).toBe(412);
  const releaseProgress = await f.native.call('POST', `${releaseStage}:progress`, {});
  expect(releaseProgress.value.stage).toMatchObject({
    state: 'collecting',
    inputCount: '0',
    sourceRevisionId: releaseBook.created.revisionId,
    expectedHeadRevisionId: releaseBook.created.revisionId,
    expectedPublicationId: releaseBook.published.revisionId,
  });
  expect(await selectedRelease(releaseBook.catalogueId)).toBe(changedRelease.value.revisionId);
});

test('selection advance replays acknowledged steps and fences stale settlement and closure', async () => {
  const startSelection = async (book: Awaited<ReturnType<typeof newBook>>, occurrenceIds: string[]) => {
    const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
      stageId: book.newId(),
      expectedRevisionId: book.created.revisionId,
      expectedPublicationId: book.published.revisionId,
      mode: 'selection',
    });
    expect(started.status).toBe(202);
    const stageId = started.value.stageId as string;
    const stagePath = prepPath(book.path, stageId);
    expect(
      (
        await f.native.call('POST', `${stagePath}:appendSelectionBatch`, {
          batchId: book.newId(),
          occurrenceIds,
        })
      ).status,
    ).toBe(200);
    expect((await f.native.call('POST', `${stagePath}:freezeSelection`, {})).status).toBe(200);
    return { stageId, stagePath };
  };
  const stepTotals = async (book: Awaited<ReturnType<typeof newBook>>, stageId: string) =>
    (
      await f.native.pool.query<{ candidates: string; steps: string }>(
        `SELECT
           (SELECT count(*)::text FROM content.hosted_publication_staging_candidate
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidates,
           (SELECT count(*)::text FROM content.hosted_publication_staging_step
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS steps`,
        [routeOf(book.catalogueId), book.catalogueId, stageId],
      )
    ).rows[0];

  const settlementBook = await newBook(20);
  const settlement = await startSelection(
    settlementBook,
    settlementBook.placements.map(({ occurrenceId }) => occurrenceId),
  );
  const settledStepId = settlementBook.newId();
  const settled = await f.native.call(
    'POST',
    `${settlement.stagePath}:advance`,
    { stepId: settledStepId },
    { key: crypto.randomUUID() },
  );
  expect(settled.status).toBe(200);
  expect(settled.value.stage).toMatchObject({ state: 'building', settledInputCount: '20', candidateCount: '20' });
  const revised = await f.native.call('POST', `${settlementBook.path}:appendRootChapter`, {
    expectedRevisionId: settlementBook.created.revisionId,
    occurrenceId: settlementBook.newId(),
    title: 'A later draft edit',
    target: settlementBook.target,
  });
  expect(revised.status).toBe(200);
  const settledReplay = await f.native.call(
    'POST',
    `${settlement.stagePath}:advance`,
    { stepId: settledStepId },
    { key: crypto.randomUUID() },
  );
  expect(settledReplay.status).toBe(200);
  expect(settledReplay.value).toEqual(settled.value);
  expect(
    (await f.native.call('POST', `${settlement.stagePath}:advance`, { stepId: settlementBook.newId() })).status,
  ).toBe(412);
  expect((await f.native.call('POST', `${settlement.stagePath}:progress`, {})).value.stage).toMatchObject({
    state: 'building',
    settledInputCount: '20',
    candidateCount: '20',
  });
  expect(await stepTotals(settlementBook, settlement.stageId)).toEqual({ candidates: '20', steps: '1' });
  expect(await selectedRelease(settlementBook.catalogueId)).toBe(settlementBook.published.revisionId);

  const closureBook = await newBook();
  const closure = await startSelection(closureBook, [closureBook.nestedChapter]);
  expect((await f.native.call('POST', `${closure.stagePath}:advance`, { stepId: closureBook.newId() })).status).toBe(
    200,
  );
  const closingStepId = closureBook.newId();
  const closing = await f.native.call(
    'POST',
    `${closure.stagePath}:advance`,
    { stepId: closingStepId },
    { key: crypto.randomUUID() },
  );
  expect(closing.status).toBe(200);
  expect(closing.value.stage).toMatchObject({ state: 'closing', candidateCount: '1', closureCheckedCount: '0' });
  const changedRelease = await f.native.call('POST', `${closureBook.path}:publish`, {
    expectedRevisionId: closureBook.created.revisionId,
    expectedPublicationId: closureBook.published.revisionId,
    occurrenceIds: [closureBook.nestedChapter],
  });
  expect(changedRelease.status).toBe(200);
  const closingReplay = await f.native.call(
    'POST',
    `${closure.stagePath}:advance`,
    { stepId: closingStepId },
    { key: crypto.randomUUID() },
  );
  expect(closingReplay.status).toBe(200);
  expect(closingReplay.value).toEqual(closing.value);
  expect((await f.native.call('POST', `${closure.stagePath}:advance`, { stepId: closureBook.newId() })).status).toBe(
    412,
  );
  expect((await f.native.call('POST', `${closure.stagePath}:progress`, {})).value.stage).toMatchObject({
    state: 'closing',
    candidateCount: '1',
    closureFrontier: '-1',
    closureCheckedCount: '0',
  });
  expect(await stepTotals(closureBook, closure.stageId)).toEqual({ candidates: '1', steps: '2' });
  expect(await selectedRelease(closureBook.catalogueId)).toBe(changedRelease.value.revisionId);
});

test('whole-source advance replays retained steps and rejects stale draft or publication pointers', async () => {
  const book = await newBook(22);
  const candidateCount = async (stageId: string) =>
    Number(
      (
        await f.native.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM content.hosted_publication_staging_candidate WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3',
          [routeOf(book.catalogueId), book.catalogueId, stageId],
        )
      ).rows[0]?.count ?? '0',
    );

  const firstStageId = book.newId();
  const firstStagePath = prepPath(book.path, firstStageId);
  const firstStart = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: firstStageId,
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(firstStart.status).toBe(202);
  const firstStepId = book.newId();
  const firstStep = await f.native.call(
    'POST',
    `${firstStagePath}:advance`,
    { stepId: firstStepId },
    { key: crypto.randomUUID() },
  );
  expect(firstStep.status).toBe(200);
  expect(firstStep.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });

  const revised = await f.native.call('POST', `${book.path}:appendRootChapter`, {
    expectedRevisionId: book.created.revisionId,
    occurrenceId: book.newId(),
    title: 'A later draft edit',
    target: book.target,
  });
  expect(revised.status).toBe(200);
  const firstReplay = await f.native.call(
    'POST',
    `${firstStagePath}:advance`,
    { stepId: firstStepId },
    { key: crypto.randomUUID() },
  );
  expect(firstReplay.status).toBe(200);
  expect(firstReplay.value).toEqual(firstStep.value);
  expect((await f.native.call('POST', `${firstStagePath}:advance`, { stepId: book.newId() })).status).toBe(412);
  expect((await f.native.call('POST', `${firstStagePath}:progress`, {})).value.stage).toMatchObject({
    state: 'building',
    sourceFrontier: '19',
    candidateCount: '20',
  });
  expect(await candidateCount(firstStageId)).toBe(20);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const secondStageId = book.newId();
  const secondStagePath = prepPath(book.path, secondStageId);
  const secondStart = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: secondStageId,
    expectedRevisionId: revised.value.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(secondStart.status).toBe(202);
  const secondStep = await f.native.call('POST', `${secondStagePath}:advance`, { stepId: book.newId() });
  expect(secondStep.status).toBe(200);
  expect(secondStep.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });
  const movedRelease = await f.native.call('POST', `${book.path}:publish`, {
    expectedRevisionId: revised.value.revisionId,
    expectedPublicationId: book.published.revisionId,
    occurrenceIds: [book.nestedChapter],
  });
  expect(movedRelease.status).toBe(200);
  expect((await f.native.call('POST', `${secondStagePath}:advance`, { stepId: book.newId() })).status).toBe(412);
  expect((await f.native.call('POST', `${secondStagePath}:progress`, {})).value.stage).toMatchObject({
    state: 'building',
    sourceFrontier: '19',
    candidateCount: '20',
  });
  expect(await candidateCount(secondStageId)).toBe(20);
  expect(await selectedRelease(book.catalogueId)).toBe(movedRelease.value.revisionId);
});

test('legacy advance receipts without checkpoints require progress recovery and a new step ID', async () => {
  const book = await newBook(22);
  const stageId = book.newId();
  const stagePath = prepPath(book.path, stageId);
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId,
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(started.status).toBe(202);

  const committedStep = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(committedStep.status).toBe(200);
  expect(committedStep.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });

  const legacyStepId = book.newId();
  await f.native.pool.query(
    `INSERT INTO content.hosted_publication_staging_step
       (route,catalogue_id,stage_id,step_id,phase,from_frontier,to_frontier,processed,result_state)
     VALUES ($1,$2,$3,$4,'whole',-1,19,20,'more')`,
    [routeOf(book.catalogueId), book.catalogueId, stageId, legacyStepId],
  );
  const retainedCounts = async () =>
    (
      await f.native.pool.query<{ candidates: string; steps: string }>(
        `SELECT
           (SELECT count(*)::text FROM content.hosted_publication_staging_candidate
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidates,
           (SELECT count(*)::text FROM content.hosted_publication_staging_step
            WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS steps`,
        [routeOf(book.catalogueId), book.catalogueId, stageId],
      )
    ).rows[0];
  const beforeReplay = await retainedCounts();

  const unavailableReplay = await f.native.call('POST', `${stagePath}:advance`, { stepId: legacyStepId });
  expect(unavailableReplay.status).toBe(412);
  expect(unavailableReplay.value).toMatchObject({ code: 'precondition_failed' });
  expect(await retainedCounts()).toEqual(beforeReplay);

  const current = await f.native.call('POST', `${stagePath}:progress`, {});
  expect(current.status).toBe(200);
  expect(current.value.stage).toMatchObject({ state: 'building', sourceFrontier: '19', candidateCount: '20' });
  const continued = await f.native.call('POST', `${stagePath}:advance`, { stepId: book.newId() });
  expect(continued.status).toBe(200);
  expect(continued.value.stage).toMatchObject({ state: 'ready', sourceFrontier: '25', candidateCount: '26' });
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

test('Cancel emits only for a persisted transition and preserves the selected edition', async () => {
  const book = await newBook();
  const start = (stageId: string) =>
    f.native.call('POST', `${book.path}:prepareRelease`, {
      stageId,
      expectedRevisionId: book.created.revisionId,
      expectedPublicationId: book.published.revisionId,
      mode: 'whole',
    });

  const cancelledStart = await start(book.newId());
  expect(cancelledStart.status).toBe(202);
  const cancelledPath = prepPath(book.path, cancelledStart.value.stageId as string);
  const beforeCancel = await preparationEventCount(book.catalogueId);
  const cancelKey = crypto.randomUUID();
  const cancelled = await f.native.call('POST', `${cancelledPath}:cancel`, {}, { key: cancelKey });
  expect(cancelled.value.stage.state).toBe('cancelled');
  expect(await preparationEventCount(book.catalogueId)).toBe(beforeCancel + 1);
  const cancelReplay = await f.native.call('POST', `${cancelledPath}:cancel`, {}, { key: cancelKey });
  expect(cancelReplay.value).toEqual(cancelled.value);
  const repeatedCancel = await f.native.call('POST', `${cancelledPath}:cancel`, {}, { key: crypto.randomUUID() });
  expect(repeatedCancel.value.stage.state).toBe('cancelled');
  expect(await preparationEventCount(book.catalogueId)).toBe(beforeCancel + 1);

  const expiryStart = await start(book.newId());
  expect(expiryStart.status).toBe(202);
  const expiryStageId = expiryStart.value.stageId as string;
  const expiryPath = prepPath(book.path, expiryStageId);
  await f.native.pool.query(
    `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 second'
     WHERE catalogue_id=$1 AND stage_id=$2`,
    [book.catalogueId, expiryStageId],
  );
  const beforeExpiry = await preparationEventCount(book.catalogueId);
  const expiryKey = crypto.randomUUID();
  const expired = await f.native.call('POST', `${expiryPath}:cancel`, {}, { key: expiryKey });
  expect(expired.value.stage.state).toBe('expired');
  expect(await preparationEventCount(book.catalogueId)).toBe(beforeExpiry + 1);
  const expiryReplay = await f.native.call('POST', `${expiryPath}:cancel`, {}, { key: expiryKey });
  expect(expiryReplay.value).toEqual(expired.value);
  expect(await preparationEventCount(book.catalogueId)).toBe(beforeExpiry + 1);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
});
