import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HostedDependencies, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  beginHostedPublicationStaging,
  cancelHostedPublicationStaging,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  sealHostedVersionReleaseCandidate,
} from '../../src/content/hosted-version-release-candidate.ts';
import {
  advanceHostedPublicationRetention,
  HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT,
  HOSTED_PUBLICATION_RETENTION_SWEEP_STEP_BUDGET,
  type HostedPublicationRetentionResult,
} from '../../src/content/hosted-publication-retention.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);
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

async function createSource() {
  const source = await f.native.thread();
  const target = f.target(source);
  const occurrenceIds = Array.from({ length: 128 }, () => f.newOccurrenceId());
  const placements: HostedPlacement[] = occurrenceIds.map((occurrenceId, position) => ({
    occurrenceId,
    parentId: null,
    position,
    title: `Retention chapter ${position}`,
    kind: 'chapter',
    target,
  }));
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements,
  });
  const publicationBody = {
    expectedRevisionId: created.revisionId,
    expectedPublicationId: null,
    occurrenceIds: [occurrenceIds.at(-1)!],
  };
  const publicationKey = crypto.randomUUID();
  const publication = await f.native.call('POST', `/v1/hostedCatalogues/${f.catalogueId}:publish`, publicationBody, {
    key: publicationKey,
  });
  expect(publication.status).toBe(200);
  return {
    target,
    occurrenceIds,
    sourceRevisionId: created.revisionId,
    publicationId: publication.value.revisionId,
    publication,
    publicationBody,
    publicationKey,
  };
}

async function createCandidate(source: Awaited<ReturnType<typeof createSource>>, expiresAt: Date) {
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId: source.sourceRevisionId,
      expectedPublicationId: source.publicationId,
      mode: 'whole',
      expiresAt,
    }),
  );

  let staged = await transaction((client) =>
    advanceHostedPublicationStaging(
      dependencies(),
      client,
      f.native.author.actor,
      locator,
      f.newOccurrenceId(),
      Date.now() + 120_000,
    ),
  );
  while (staged.progress.state !== 'ready') {
    staged = await transaction((client) =>
      advanceHostedPublicationStaging(
        dependencies(),
        client,
        f.native.author.actor,
        locator,
        f.newOccurrenceId(),
        Date.now() + 120_000,
      ),
    );
  }

  const seal = (await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, locator)))
    .seal;
  let candidate = await transaction((client) =>
    beginHostedVersionReleaseCandidate(client, f.native.author.actor, seal),
  );
  while (!candidate.checkpoint.coverageComplete) {
    candidate = await transaction((client) =>
      applyHostedVersionReleaseCandidatePage(
        client,
        f.native.author.actor,
        seal,
        candidate.checkpoint.afterSourceOrder,
      ),
    );
  }
  const sealed = await transaction((client) => sealHostedVersionReleaseCandidate(client, f.native.author.actor, seal));
  return {
    locator,
    generationId: candidate.checkpoint.generationId,
    generationSequence: sealed.candidate.snapshot.sequence.toString(),
  };
}

async function createUnsealedStage(source: Awaited<ReturnType<typeof createSource>>, expiresAt: Date) {
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId: source.sourceRevisionId,
      expectedPublicationId: source.publicationId,
      mode: 'whole',
      expiresAt,
    }),
  );
  let staged = await transaction((client) =>
    advanceHostedPublicationStaging(
      dependencies(),
      client,
      f.native.author.actor,
      locator,
      f.newOccurrenceId(),
      Date.now() + 120_000,
    ),
  );
  while (staged.progress.state !== 'ready') {
    staged = await transaction((client) =>
      advanceHostedPublicationStaging(
        dependencies(),
        client,
        f.native.author.actor,
        locator,
        f.newOccurrenceId(),
        Date.now() + 120_000,
      ),
    );
  }
  return locator;
}

async function createCompletedHistory(
  source: Awaited<ReturnType<typeof createSource>>,
  count: number,
): Promise<string[]> {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const locators = Array.from({ length: count }, () => ({ catalogueId: f.catalogueId, stageId: f.newOccurrenceId() }));
  await transaction(async (client) => {
    for (const locator of locators) {
      await beginHostedPublicationStaging(client, f.native.author.actor, {
        ...locator,
        expectedHeadRevisionId: source.sourceRevisionId,
        expectedPublicationId: source.publicationId,
        mode: 'whole',
        expiresAt,
      });
    }
  });

  const stageIds = locators.map(({ stageId }) => stageId);
  await transaction(async (client) => {
    await client.query(
      `UPDATE content.hosted_publication_staging SET status='expired'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
      [route, f.catalogueId, stageIds],
    );
    await client.query(
      `INSERT INTO content.hosted_publication_staging_cleanup
         (route,catalogue_id,stage_id,owner_epoch,terminal_status)
       SELECT route,catalogue_id,stage_id,owner_epoch,'expired'
       FROM content.hosted_publication_staging
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
      [route, f.catalogueId, stageIds],
    );
    for (const stageId of stageIds) {
      const authority = `${route}:${f.catalogueId}:${stageId}:${f.native.author.actor.authnEpoch}`;
      await client.query("SELECT set_config('content.hosted_publication_staging_cleanup',$1,true)", [authority]);
      await client.query(
        `UPDATE content.hosted_publication_staging_cleanup SET cleanup_active=true
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [route, f.catalogueId, stageId],
      );
      await client.query(
        `UPDATE content.hosted_publication_staging_cleanup
         SET phase='done',completed_at=clock_timestamp(),cleanup_active=false
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [route, f.catalogueId, stageId],
      );
    }
    await client.query(
      `DELETE FROM content.hosted_publication_retention_pending
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
      [route, f.catalogueId, stageIds],
    );
  });
  return stageIds;
}

async function pinCandidate(generationId: string, sequence: string, sourceRevisionId: string): Promise<void> {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  await transaction(async (client) => {
    const revisionId = f.newOccurrenceId();
    await client.query(
      `INSERT INTO content.hosted_structure_revision
         (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,'publication',$4,$5,$6)`,
      [route, f.catalogueId, revisionId, sourceRevisionId, f.newOccurrenceId(), new Date()],
    );
    await client.query(
      `INSERT INTO content.hosted_version_revision
         (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
       VALUES ($1,$2,$3,'publication',$4,'candidate',$5)`,
      [route, f.catalogueId, revisionId, generationId, sequence],
    );
  });
}

async function markExpired(stageId: string): Promise<void> {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  await transaction((client) =>
    client.query(
      `UPDATE content.hosted_publication_staging SET status='expired'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
         AND status NOT IN ('cancelled','expired','failed')`,
      [route, f.catalogueId, stageId],
    ),
  );
}

async function runSweep(sweepId: string, cutoff: Date, first?: HostedPublicationRetentionResult) {
  const results: HostedPublicationRetentionResult[] = first ? [first] : [];
  const start = first ? 1 : 0;
  if (first?.hasMoreWork === false) return results;
  for (let segment = start; segment < HOSTED_PUBLICATION_RETENTION_SWEEP_STEP_BUDGET; segment++) {
    const result = await advanceHostedPublicationRetention(f.native.pool, `${sweepId}:retention:${segment}`, cutoff);
    results.push(result);
    if (!result.hasMoreWork) break;
  }
  return results;
}

test('bounded hourly retention skips a locked stage, resumes pages and defers a pinned candidate', async () => {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  const source = await createSource();
  const history = await createCompletedHistory(source, HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT + 20);
  const now = Date.now();
  const pinned = await createCandidate(source, new Date(now + 10 * 60_000));
  const abandoned = await createUnsealedStage(source, new Date(now + 20 * 60_000));
  const eligible = await createCandidate(source, new Date(now + 30 * 60_000));
  await pinCandidate(pinned.generationId, pinned.generationSequence, source.sourceRevisionId);
  await markExpired(pinned.locator.stageId);
  await markExpired(abandoned.stageId);
  await markExpired(eligible.locator.stageId);
  const cutoff = new Date(now + 4 * 60 * 60_000);
  const firstSweepId = crypto.randomUUID();
  const firstPassId = `${firstSweepId}:retention:0`;

  const locker = await f.native.pool.connect();
  let first: HostedPublicationRetentionResult;
  try {
    await locker.query('BEGIN');
    await locker.query(
      `SELECT stage_id FROM content.hosted_publication_staging
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 FOR UPDATE`,
      [route, f.catalogueId, abandoned.stageId],
    );
    first = await advanceHostedPublicationRetention(f.native.pool, firstPassId, cutoff);
    expect(first).toMatchObject({
      replayed: false,
      adoptionScanned: HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT,
      adopted: 0,
      advanced: true,
      locator: eligible.locator,
      cleanup: { kind: 'candidate', result: { replayed: false, deletedRows: 100, progress: { completed: false } } },
    });
    const busyPending = await f.native.pool.query<{ available_at: Date }>(
      `SELECT available_at FROM content.hosted_publication_retention_pending
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, f.catalogueId, abandoned.stageId],
    );
    expect(busyPending.rows[0]!.available_at.getTime()).toBeLessThan(cutoff.getTime());
    const busyIssue = await f.native.pool.query(
      `SELECT 1 FROM content.hosted_publication_retention_issue
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, f.catalogueId, abandoned.stageId],
    );
    expect(busyIssue.rowCount).toBe(0);
  } finally {
    await locker.query('ROLLBACK').catch(() => undefined);
    locker.release();
  }
  expect(first.examinedKeys).toBe(first.scanned + first.adoptionScanned);
  expect(first.scanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);

  const replay = await advanceHostedPublicationRetention(f.native.pool, firstPassId, cutoff);
  expect(replay).toEqual({ ...first, replayed: true });

  const results = await runSweep(firstSweepId, cutoff, first);
  const secondPass = results[1]!;
  expect(secondPass.adoptionScanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
  expect(secondPass.scanned).toBeLessThan(first.scanned);
  expect(results.reduce((sum, result) => sum + result.adoptionScanned, 0)).toBe(history.length + 3);
  expect(results.some((result) => result.locator?.stageId === eligible.locator.stageId)).toBe(true);
  expect(results.filter((result) => result.locator?.stageId === eligible.locator.stageId).length).toBeGreaterThan(1);

  const allResults = [...results];
  let abandonedCompleted = false;
  let candidateCompleted = false;
  for (let sweep = 1; sweep <= 8 && !(abandonedCompleted && candidateCompleted); sweep++) {
    const next = await runSweep(crypto.randomUUID(), cutoff);
    allResults.push(...next);
    const staging = await f.native.pool.query<{ completed: boolean }>(
      `SELECT completed_at IS NOT NULL AS completed FROM content.hosted_publication_staging_cleanup
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, f.catalogueId, abandoned.stageId],
    );
    const candidate = await f.native.pool.query<{ completed: boolean }>(
      `SELECT completed_at IS NOT NULL AS completed FROM content.hosted_version_candidate_cleanup
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, f.catalogueId, eligible.locator.stageId],
    );
    abandonedCompleted = staging.rows[0]?.completed ?? false;
    candidateCompleted = candidate.rows[0]?.completed ?? false;
  }
  expect(abandonedCompleted).toBe(true);
  expect(candidateCompleted).toBe(true);

  for (const result of allResults) {
    expect(result.scanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
    expect(result.adoptionScanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
    expect(result.examinedKeys).toBe(result.scanned + result.adoptionScanned);
    expect(result.adopted).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
    expect(result.advanced).toBe(result.cleanup !== null);
    expect(result.cleanup?.result.deletedRows ?? 0).toBeLessThanOrEqual(100);
  }

  const issue = await f.native.pool.query<{
    owner_epoch: string;
    source_revision_id: string;
    candidate_generation_id: string;
    state: string;
  }>(
    `SELECT owner_epoch::text,source_revision_id,candidate_generation_id,state
     FROM content.hosted_publication_retention_issue
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, f.catalogueId, pinned.locator.stageId],
  );
  expect(issue.rows[0]).toMatchObject({
    owner_epoch: String(f.native.author.actor.authnEpoch),
    source_revision_id: source.sourceRevisionId,
    candidate_generation_id: pinned.generationId,
    state: 'The candidate generation is retained by retained revision',
  });
  const deferred = await f.native.pool.query<{ available_at: string }>(
    `SELECT available_at::text FROM content.hosted_publication_retention_pending
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, f.catalogueId, pinned.locator.stageId],
  );
  expect(Date.parse(deferred.rows[0]!.available_at)).toBeGreaterThan(cutoff.getTime());

  const candidates = await f.native.pool.query<{ stage_id: string; status: string; generation_id: string | null }>(
    `SELECT stage_id,status,generation_id
     FROM content.hosted_version_release_candidate
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
    [route, f.catalogueId, [pinned.locator.stageId, eligible.locator.stageId]],
  );
  expect(candidates.rows).toContainEqual({
    stage_id: pinned.locator.stageId,
    status: 'sealed',
    generation_id: pinned.generationId,
  });
  expect(candidates.rows).toContainEqual({
    stage_id: eligible.locator.stageId,
    status: 'reclaimed',
    generation_id: null,
  });
  const pinnedGeneration = await f.native.pool.query(
    `SELECT 1 FROM content.hosted_tree_generation
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3`,
    [route, f.catalogueId, pinned.generationId],
  );
  expect(pinnedGeneration.rowCount).toBe(1);
  const historyFacts = await f.native.pool.query<{
    stages: string;
    pending: string;
    completed_cleanups: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM content.hosted_publication_staging
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])) AS stages,
       (SELECT count(*)::text FROM content.hosted_publication_retention_pending
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])) AS pending,
       (SELECT count(*)::text FROM content.hosted_publication_staging_cleanup
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])
          AND completed_at IS NOT NULL) AS completed_cleanups`,
    [route, f.catalogueId, history],
  );
  expect(historyFacts.rows[0]).toEqual({
    stages: String(history.length),
    pending: '0',
    completed_cleanups: String(history.length),
  });
  const cleanupReceipts = await f.native.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM content.hosted_publication_staging_cleanup_step
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, f.catalogueId, abandoned.stageId],
  );
  expect(Number(cleanupReceipts.rows[0]!.count)).toBeGreaterThan(0);

  const emptySweepId = crypto.randomUUID();
  const empty = await runSweep(emptySweepId, cutoff);
  expect(
    empty.every((result) => result.scanned === 0 && result.adoptionScanned === 0 && result.examinedKeys === 0),
  ).toBe(true);
  expect(empty.at(-1)?.hasMoreWork).toBe(false);
});

test('retention reclaims due cancelled candidates, preserves pins and keeps public reads and receipts', async () => {
  const sharedFixture = f;
  f = await hostedChaptersFixture();
  try {
    const route = routeOf(f.catalogueId)!;
    const source = await createSource();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    const eligible = await createCandidate(source, expiresAt);
    const pinned = await createCandidate(source, expiresAt);
    const young = await createCandidate(source, expiresAt);
    await pinCandidate(pinned.generationId, pinned.generationSequence, source.sourceRevisionId);
    for (const candidate of [eligible, pinned, young]) {
      const cancelled = await transaction((client) =>
        cancelHostedPublicationStaging(client, f.native.author.actor, candidate.locator),
      );
      expect(cancelled.state).toBe('cancelled');
    }
    const publicPath = `/v1/hostedCatalogues/${f.catalogueId}/occurrences/${source.occurrenceIds.at(-1)!}?kind=publication`;
    const publicBefore = await f.native.call('GET', publicPath, undefined, { anonymous: true });
    expect(publicBefore.status).toBe(200);
    const audit = () =>
      f.native.pool.query(
        `SELECT to_jsonb(seal) AS seal,
         (SELECT jsonb_agg(to_jsonb(target)) FROM content.hosted_publication_staging_target target
          WHERE target.route=seal.route AND target.catalogue_id=seal.catalogue_id
            AND target.stage_id=seal.stage_id) AS observations,
         (SELECT count(*)::text FROM content.hosted_publication_staging_step step
          WHERE step.route=seal.route AND step.catalogue_id=seal.catalogue_id
            AND step.stage_id=seal.stage_id) AS staging_receipts,
         (SELECT count(*)::text FROM content.hosted_version_release_candidate_page page
          WHERE page.route=seal.route AND page.catalogue_id=seal.catalogue_id
            AND page.stage_id=seal.stage_id) AS build_receipts
       FROM content.hosted_publication_staging_seal seal
       WHERE seal.route=$1 AND seal.catalogue_id=$2 AND seal.stage_id=$3`,
        [route, f.catalogueId, eligible.locator.stageId],
      );
    const auditBefore = (await audit()).rows;
    expect(auditBefore[0].observations).toHaveLength(1);

    const premature = await runSweep(crypto.randomUUID(), new Date());
    expect(premature.every((result) => result.scanned === 0 && !result.advanced)).toBe(true);
    // Age just the two due fixtures and their existing pending entries; the young cancellation stays private.
    const cutoff = new Date();
    const due = new Date(cutoff.getTime() - 1);
    await transaction(async (client) => {
      const stageIds = [eligible.locator.stageId, pinned.locator.stageId];
      await client.query(
        `UPDATE content.hosted_publication_staging SET expires_at=$4
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
        [route, f.catalogueId, stageIds, due],
      );
      await client.query(
        `UPDATE content.hosted_publication_retention_pending SET available_at=$4
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=ANY($3::uuid[])`,
        [route, f.catalogueId, stageIds, due],
      );
    });
    const passId = `${crypto.randomUUID()}:retention:0`;
    const first = await advanceHostedPublicationRetention(f.native.pool, passId, cutoff);
    expect(first.cleanup).toMatchObject({
      kind: 'candidate',
      result: { deletedRows: 100, progress: { terminalStatus: 'cancelled', completed: false } },
    });
    expect(await advanceHostedPublicationRetention(f.native.pool, passId, cutoff)).toEqual({
      ...first,
      replayed: true,
    });
    const results = [first];
    for (let sweep = 0; sweep < 8 && !results.some((result) => result.cleanup?.result.progress.completed); sweep++) {
      results.push(...(await runSweep(crypto.randomUUID(), cutoff)));
    }
    expect(results.some((result) => result.cleanup?.result.progress.completed)).toBe(true);
    for (const result of results) {
      expect(result.scanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
      expect(result.adoptionScanned).toBeLessThanOrEqual(HOSTED_PUBLICATION_RETENTION_SCAN_LIMIT);
      expect(result.cleanup?.result.deletedRows ?? 0).toBeLessThanOrEqual(100);
      if (result.cleanup) {
        expect(result.locator).toEqual(eligible.locator);
        expect(result.cleanup.result.progress.terminalStatus).toBe('cancelled');
      }
    }
    const states = await f.native.pool.query(
      `SELECT stage.stage_id,stage.status,cleanup.terminal_status,
         candidate.status AS candidate_status,candidate.generation_id,
         generation.retirement_claimed,
         pending.available_at IS NOT NULL AS pending,
         cleanup.completed_at IS NOT NULL AS completed
       FROM content.hosted_publication_staging stage
       JOIN content.hosted_version_release_candidate candidate USING (route,catalogue_id,stage_id)
       LEFT JOIN content.hosted_version_candidate_cleanup cleanup USING (route,catalogue_id,stage_id)
       LEFT JOIN content.hosted_tree_generation generation
         ON generation.route=stage.route AND generation.catalogue_id=stage.catalogue_id
        AND generation.generation_id=candidate.generation_id
       LEFT JOIN content.hosted_publication_retention_pending pending
         ON pending.route=stage.route AND pending.catalogue_id=stage.catalogue_id AND pending.stage_id=stage.stage_id
       WHERE stage.route=$1 AND stage.catalogue_id=$2 AND stage.stage_id=ANY($3::uuid[])`,
      [route, f.catalogueId, [eligible.locator.stageId, pinned.locator.stageId, young.locator.stageId]],
    );
    expect(states.rows).toContainEqual({
      stage_id: eligible.locator.stageId,
      status: 'cancelled',
      terminal_status: 'cancelled',
      candidate_status: 'reclaimed',
      generation_id: null,
      retirement_claimed: null,
      pending: false,
      completed: true,
    });
    for (const retained of [pinned, young])
      expect(states.rows).toContainEqual({
        stage_id: retained.locator.stageId,
        status: 'cancelled',
        terminal_status: null,
        candidate_status: 'sealed',
        generation_id: retained.generationId,
        retirement_claimed: false,
        pending: true,
        completed: false,
      });
    const issue = await f.native.pool.query(
      `SELECT state FROM content.hosted_publication_retention_issue
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, f.catalogueId, pinned.locator.stageId],
    );
    expect(issue.rows[0].state).toContain('retained by retained revision');
    expect((await audit()).rows).toEqual(auditBefore);
    const publicAfter = await f.native.call('GET', publicPath, undefined, { anonymous: true });
    expect(publicAfter.status).toBe(200);
    expect(publicAfter.value.document.sha256).toBe(publicBefore.value.document.sha256);
    expect(
      await f.native.call('POST', `/v1/hostedCatalogues/${f.catalogueId}:publish`, source.publicationBody, {
        key: source.publicationKey,
      }),
    ).toEqual(source.publication);
  } finally {
    await f.close();
    f = sharedFixture;
  }
});
