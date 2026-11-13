import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HostedDependencies, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  beginHostedPublicationStaging,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  sealHostedVersionReleaseCandidate,
} from '../../src/content/hosted-version-release-candidate.ts';
import { advanceHostedPublicationRetention } from '../../src/content/hosted-publication-retention.ts';
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
  const published = await f.native.command(
    `/v1/hostedCatalogues/${f.catalogueId}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [occurrenceIds.at(-1)!],
    },
    200,
  );
  return { target, occurrenceIds, sourceRevisionId: created.revisionId, publicationId: published.revisionId };
}

async function createCandidate(
  source: Awaited<ReturnType<typeof createSource>>,
  expiresAt: Date,
) {
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

  const seal = (await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, locator))).seal;
  let candidate = await transaction((client) => beginHostedVersionReleaseCandidate(client, f.native.author.actor, seal));
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

async function createUnsealedStage(
  source: Awaited<ReturnType<typeof createSource>>,
  expiresAt: Date,
) {
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
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status IN ('ready','sealed')`,
      [route, f.catalogueId, stageId],
    ),
  );
}

test('bounded retention skips a pinned candidate, advances a later stage and replays exact progress', async () => {
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');
  const source = await createSource();
  const now = Date.now();
  const pinnedExpiresAt = new Date(now + 60 * 60_000);
  const pinned = await createCandidate(source, pinnedExpiresAt);
  const abandoned = await createUnsealedStage(source, new Date(now + 90 * 60_000));
  const eligible = await createCandidate(source, new Date(now + 2 * 60 * 60_000));
  await pinCandidate(pinned.generationId, pinned.generationSequence, source.sourceRevisionId);
  await markExpired(pinned.locator.stageId);
  await markExpired(abandoned.stageId);
  await markExpired(eligible.locator.stageId);
  await f.native.pool.query(
    `INSERT INTO content.hosted_publication_retention_cursor(singleton) VALUES (true)
     ON CONFLICT (singleton) DO UPDATE SET after_expires_at=$1,after_route=$2,
       after_catalogue_id=$3,after_stage_id=$4,last_pass_id=NULL,last_pass_result=NULL`,
    [new Date(pinnedExpiresAt.getTime() - 1), route, f.catalogueId, pinned.locator.stageId],
  );
  const cutoff = new Date(now + 3 * 60 * 60_000);
  const passRoot = crypto.randomUUID();

  let first: Awaited<ReturnType<typeof advanceHostedPublicationRetention>> | undefined;
  let firstPassId = '';
  for (let pass = 0; pass < 200; pass++) {
    const passId = `${passRoot}:${pass}`;
    const result = await advanceHostedPublicationRetention(f.native.pool, passId, cutoff);
    if (result.advanced && result.locator?.stageId === abandoned.stageId) {
      first = result;
      firstPassId = passId;
      break;
    }
  }
  expect(first).toBeDefined();
  expect(first).toMatchObject({
    replayed: false,
    advanced: true,
    locator: abandoned,
    cleanup: {
      kind: 'staging',
      result: {
        replayed: false,
        deletedRows: 100,
        progress: { phase: 'candidate', completed: false },
      },
    },
  });

  const replay = await advanceHostedPublicationRetention(f.native.pool, firstPassId, cutoff);
  expect(replay).toEqual({ ...first!, replayed: true });
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

  let abandonedCompleted = false;
  let candidateCompleted = false;
  for (let pass = 200; pass < 400 && !(abandonedCompleted && candidateCompleted); pass++) {
    const result = await advanceHostedPublicationRetention(f.native.pool, `${passRoot}:${pass}`, cutoff);
    if (result.advanced) {
      expect(result.cleanup!.result.deletedRows).toBeLessThanOrEqual(100);
      const samePass = await advanceHostedPublicationRetention(f.native.pool, `${passRoot}:${pass}`, cutoff);
      expect(samePass).toEqual({ ...result, replayed: true });
      if (result.locator?.stageId === abandoned.stageId) {
        expect(result.cleanup!.kind).toBe('staging');
        abandonedCompleted = result.cleanup!.result.progress.completed;
      } else if (result.locator?.stageId === eligible.locator.stageId) {
        expect(result.cleanup!.kind).toBe('candidate');
        candidateCompleted = result.cleanup!.result.progress.completed;
        if (!candidateCompleted) expect(Number(result.cleanup!.result.progress.deletedRowCount)).toBeGreaterThan(100);
      } else {
        throw new Error('Retention advanced a stage outside the focused fixture');
      }
    }
  }
  expect(abandonedCompleted).toBe(true);
  expect(candidateCompleted).toBe(true);

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
  const abandonedFacts = await f.native.pool.query<{ candidate_count: string; target_count: string }>(
    `SELECT
       (SELECT count(*)::text FROM content.hosted_publication_staging_candidate
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS candidate_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_target
        WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3) AS target_count`,
    [route, f.catalogueId, abandoned.stageId],
  );
  expect(abandonedFacts.rows[0]).toEqual({ candidate_count: '0', target_count: '0' });
});
