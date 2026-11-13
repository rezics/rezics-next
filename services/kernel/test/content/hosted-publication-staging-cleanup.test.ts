import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  cancelHostedPublicationStaging,
  freezeHostedPublicationSelection,
  readHostedPublicationStagingProgress,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import {
  advanceHostedPublicationStagingCleanup,
  HOSTED_PUBLICATION_STAGING_CLEANUP_STEP_LIMIT,
} from '../../src/content/hosted-publication-staging-cleanup.ts';
import type { HostedPublicationStagingLocator } from '../../src/content/hosted-publication-staging-model.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

async function transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await f.native.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dependencies(): HostedDependencies {
  return {
    pool: f.native.pool,
    access: f.native.system.access,
    tokens: f.native.system.tokenKeys,
    clock: () => new Date(),
  };
}

async function createPublishedDraft() {
  const source = await f.native.thread();
  const target = f.target(source);
  const partId = f.newOccurrenceId();
  const chapterId = f.newOccurrenceId();
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Part', kind: 'part' as const },
      { occurrenceId: chapterId, parentId: partId, position: 0, title: 'Chapter', kind: 'chapter' as const, target },
    ],
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [partId, chapterId],
    },
    200,
  );
  return { source, target, partId, chapterId, created, published };
}

async function begin(
  sourceRevisionId: string,
  expectedPublicationId: string | null,
  mode: 'whole' | 'selection',
  expiresAt = new Date(Date.now() + 60 * 60_000),
): Promise<HostedPublicationStagingLocator> {
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId: sourceRevisionId,
      expectedPublicationId,
      mode,
      expiresAt,
    }),
  );
  return locator;
}

async function advance(locator: HostedPublicationStagingLocator, stepId = f.newOccurrenceId()) {
  return transaction((client) =>
    advanceHostedPublicationStaging(
      dependencies(),
      client,
      f.native.author.actor,
      locator,
      stepId,
      Date.now() + 120_000,
    ),
  );
}

async function advanceTo(locator: HostedPublicationStagingLocator, state: 'ready' | 'failed') {
  let result: Awaited<ReturnType<typeof advance>> | null = null;
  let stepId = '';
  while (result?.progress.state !== state) {
    stepId = f.newOccurrenceId();
    result = await advance(locator, stepId);
  }
  return { result: result!, stepId };
}

async function counts(locator: HostedPublicationStagingLocator) {
  const route = routeOf(locator.catalogueId);
  if (route === null) throw new Error('Hosted fixture locator has no route');
  const result = await f.native.pool.query<{
    input_count: string;
    candidate_count: string;
    target_count: string;
    step_count: string;
    batch_count: string;
    cleanup_step_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM content.hosted_publication_staging_input
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS input_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_candidate
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidate_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_target
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS target_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_step
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS step_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_batch
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS batch_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_cleanup_step
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS cleanup_step_count`,
    [route, locator.catalogueId, locator.stageId],
  );
  return result.rows[0]!;
}

async function cleanup(locator: HostedPublicationStagingLocator, stepId = f.newOccurrenceId()) {
  return transaction((client) =>
    advanceHostedPublicationStagingCleanup(client, f.native.author.actor, locator, stepId),
  );
}

test('failed staging with 513 inputs reclaims private rows in bounded steps and replays receipts', async () => {
  const { partId, chapterId, created, published } = await createPublishedDraft();

  const unrelated = await begin(created.revisionId, published.revisionId, 'whole');
  await advanceTo(unrelated, 'ready');
  await transaction((client) => cancelHostedPublicationStaging(client, f.native.author.actor, unrelated));

  const locator = await begin(created.revisionId, published.revisionId, 'selection');
  const batch = [chapterId, ...Array.from({ length: 511 }, () => partId)];
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...locator,
      batchId: f.newOccurrenceId(),
      occurrenceIds: batch,
    }),
  );
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...locator,
      batchId: f.newOccurrenceId(),
      occurrenceIds: [partId],
    }),
  );
  await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, locator));
  const { result: failed, stepId: terminalStepId } = await advanceTo(locator, 'failed');
  expect(failed.progress).toMatchObject({ state: 'failed', inputCount: '513', candidateCount: '1' });
  expect(await counts(locator)).toMatchObject({ input_count: '513', candidate_count: '1', target_count: '1' });

  const firstStepId = f.newOccurrenceId();
  const first = await cleanup(locator, firstStepId);
  expect(first).toMatchObject({ replayed: false, deletedRows: 100, progress: { phase: 'input' } });
  const replay = await cleanup(locator, firstStepId);
  expect(replay).toEqual({ ...first, replayed: true });

  let last = first;
  const pages = [first];
  while (!last.progress.completed) {
    last = await cleanup(locator);
    pages.push(last);
  }
  expect(pages.every((page) => page.deletedRows <= HOSTED_PUBLICATION_STAGING_CLEANUP_STEP_LIMIT)).toBe(true);
  expect(pages.reduce((sum, page) => sum + page.deletedRows, 0)).toBe(515);
  expect(last.progress).toMatchObject({ terminalStatus: 'failed', phase: 'done', completed: true });
  expect(await cleanup(locator, firstStepId)).toEqual({ ...first, replayed: true });

  const after = await counts(locator);
  expect(after).toMatchObject({
    input_count: '0',
    candidate_count: '0',
    target_count: '0',
    batch_count: '2',
    cleanup_step_count: String(pages.length),
  });
  expect(Number(after.step_count)).toBeGreaterThan(0);
  expect(
    await transaction((client) => readHostedPublicationStagingProgress(client, f.native.author.actor, locator)),
  ).toMatchObject({
    state: 'failed',
    inputCount: '513',
    candidateCount: '1',
  });
  expect(await advance(locator, terminalStepId)).toMatchObject({ replayed: true, progress: { state: 'failed' } });

  const catalogueRoute = routeOf(f.catalogueId);
  if (catalogueRoute === null) throw new Error('Hosted fixture catalogue has no route');
  const preserved = await f.native.pool.query(
    `SELECT c.publication_id,
       (SELECT count(*) FROM content.hosted_placement p
        WHERE p.route=c.route AND p.catalogue_id=c.catalogue_id AND p.revision_id=$3
          AND p.occurrence_id=ANY($4::uuid[]))::text AS published_links,
       (SELECT count(*) FROM content.hosted_placement p
        WHERE p.route=c.route AND p.catalogue_id=c.catalogue_id AND p.revision_id=$5)::text AS source_placements,
       (SELECT count(*) FROM content.hosted_occurrence o
        WHERE o.route=c.route AND o.catalogue_id=c.catalogue_id AND o.occurrence_id=ANY($4::uuid[]))::text AS source_occurrences
     FROM content.hosted_catalogue c WHERE c.route=$1 AND c.catalogue_id=$2`,
    [catalogueRoute, f.catalogueId, published.revisionId, [partId, chapterId], created.revisionId],
  );
  expect(preserved.rows[0]).toMatchObject({
    publication_id: published.revisionId,
    published_links: '2',
    source_placements: '2',
    source_occurrences: '2',
  });
  expect(await counts(unrelated)).toMatchObject({ candidate_count: '2', target_count: '1' });
  let cancelledCleanup = await cleanup(unrelated);
  while (!cancelledCleanup.progress.completed) cancelledCleanup = await cleanup(unrelated);
  expect(cancelledCleanup.progress.terminalStatus).toBe('cancelled');
  expect(await counts(unrelated)).toMatchObject({ candidate_count: '0', target_count: '0' });
});

test('sealed stages stay retained and concurrent cleanup cannot remove live candidates', async () => {
  const { partId, chapterId, created, published } = await createPublishedDraft();
  const sealed = await begin(created.revisionId, published.revisionId, 'selection');
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...sealed,
      batchId: f.newOccurrenceId(),
      occurrenceIds: [partId, chapterId],
    }),
  );
  await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, sealed));
  await advanceTo(sealed, 'ready');
  await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, sealed));
  await expect(cleanup(sealed)).rejects.toThrow('Sealed hosted publication staging is retained');
  expect(await counts(sealed)).toMatchObject({ candidate_count: '2', target_count: '1' });

  const live = await begin(created.revisionId, published.revisionId, 'whole');
  const outcomes = await Promise.allSettled([advance(live), cleanup(live)]);
  expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true);
  expect(await counts(live)).toMatchObject({ candidate_count: '2', target_count: '1', cleanup_step_count: '0' });
  const liveRoute = routeOf(live.catalogueId)!;
  await expect(
    transaction((client) =>
      client.query(
        `DELETE FROM content.hosted_publication_staging_candidate
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [liveRoute, live.catalogueId, live.stageId],
      ),
    ),
  ).rejects.toThrow('Hosted publication staging facts are immutable');
  expect(await counts(live)).toMatchObject({ candidate_count: '2', target_count: '1' });
  const state = await transaction((client) =>
    readHostedPublicationStagingProgress(client, f.native.author.actor, live),
  );
  expect(state.state).toBe('ready');
});

test('expired unsealed staging enters cleanup through its native expiry transition', async () => {
  const { created, published } = await createPublishedDraft();
  const locator = await begin(created.revisionId, published.revisionId, 'whole', new Date(Date.now() + 5_000));
  await advanceTo(locator, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 5_100));

  let result = await cleanup(locator);
  while (!result.progress.completed) result = await cleanup(locator);
  expect(result.progress).toMatchObject({ terminalStatus: 'expired', phase: 'done', completed: true });
  expect(await counts(locator)).toMatchObject({ candidate_count: '0', target_count: '0' });
  expect(
    await transaction((client) => readHostedPublicationStagingProgress(client, f.native.author.actor, locator)),
  ).toMatchObject({
    state: 'expired',
    candidateCount: '2',
  });
});
