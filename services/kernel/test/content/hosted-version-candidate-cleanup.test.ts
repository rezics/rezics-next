import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  cancelHostedPublicationStaging,
  freezeHostedPublicationSelection,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import {
  advanceHostedVersionCandidateCleanup,
  HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT,
  HostedVersionCandidateCleanupConflictError,
  HostedVersionCandidateCleanupNotFoundError,
} from '../../src/content/hosted-version-candidate-cleanup.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  sealHostedVersionReleaseCandidate,
} from '../../src/content/hosted-version-release-candidate.ts';
import {
  commitHostedVersionWrite,
  createHostedVersionWrite,
  readHostedVersionHead,
} from '../../src/content/hosted-version-store.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { hostedRootAppendBase } from './support/hosted-root-append-setup.ts';

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

async function createSealedCandidate(mode: 'whole' | 'selection' = 'whole') {
  const { path, target, created, published, placements } = await hostedRootAppendBase(f);
  const appendedOccurrenceId = f.newOccurrenceId();
  const sourceHead = await f.native.command(
    `${path}:appendRootChapter`,
    {
      expectedRevisionId: created.revisionId,
      occurrenceId: appendedOccurrenceId,
      title: 'The 513th source placement',
      target,
    },
    200,
  );
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId: sourceHead.revisionId,
      expectedPublicationId: published.revisionId,
      mode,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    }),
  );

  if (mode === 'selection') {
    const occurrenceIds = [...placements.map((placement) => placement.occurrenceId), appendedOccurrenceId];
    for (let offset = 0; offset < occurrenceIds.length; offset += 512) {
      await transaction((client) =>
        appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
          ...locator,
          batchId: f.newOccurrenceId(),
          occurrenceIds: occurrenceIds.slice(offset, offset + 512),
        }),
      );
    }
    await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, locator));
  }

  let stagingPages = 0;
  let stage = await transaction((client) =>
    advanceHostedPublicationStaging(
      dependencies(),
      client,
      f.native.author.actor,
      locator,
      f.newOccurrenceId(),
      Date.now() + 120_000,
    ),
  );
  while (stage.progress.state !== 'ready') {
    stagingPages += 1;
    stage = await transaction((client) =>
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
  expect(stage.progress.candidateCount).toBe('513');

  const sourceSeal = (
    await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, locator))
  ).seal;
  let candidate = await transaction((client) =>
    beginHostedVersionReleaseCandidate(client, f.native.author.actor, sourceSeal),
  );
  let candidatePages = 0;
  while (!candidate.checkpoint.coverageComplete) {
    candidatePages += 1;
    candidate = await transaction((client) =>
      applyHostedVersionReleaseCandidatePage(
        client,
        f.native.author.actor,
        sourceSeal,
        candidate.checkpoint.afterSourceOrder,
      ),
    );
  }
  const sealedCandidate = await transaction((client) =>
    sealHostedVersionReleaseCandidate(client, f.native.author.actor, sourceSeal),
  );
  return {
    locator,
    target,
    sourceHead,
    expectedPublicationId: published.revisionId,
    generationId: candidate.checkpoint.generationId,
    generationSequence: sealedCandidate.candidate.snapshot.sequence.toString(),
    stagingPages,
    candidatePages,
  };
}

async function generationState(generationId: string) {
  const route = routeOf(f.catalogueId);
  const result = await f.native.pool.query<{
    generation_kind: string;
    head_sequence: string;
    retirement_claimed: boolean;
  }>(
    `SELECT generation_kind,head_sequence::text,retirement_claimed
     FROM content.hosted_tree_generation
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3`,
    [route, f.catalogueId, generationId],
  );
  return result.rows[0] ?? null;
}

async function generationHasRows(generationId: string) {
  const route = routeOf(f.catalogueId);
  const result = await f.native.pool.query<{
    generation: boolean;
    node: boolean;
    occurrence: boolean;
    sibling_root: boolean;
    snapshot: boolean;
  }>(
    `SELECT
       EXISTS (SELECT 1 FROM content.hosted_tree_generation
         WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3) AS generation,
       EXISTS (SELECT 1 FROM content.hosted_order_node_version
         WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3) AS node,
       EXISTS (SELECT 1 FROM content.hosted_occurrence_state_version
         WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3) AS occurrence,
       EXISTS (SELECT 1 FROM content.hosted_sibling_root_version
         WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3) AS sibling_root,
       EXISTS (SELECT 1 FROM content.hosted_tree_snapshot_version
         WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3) AS snapshot`,
    [route, f.catalogueId, generationId],
  );
  return result.rows[0]!;
}

async function stageRows(stageId: string) {
  const route = routeOf(f.catalogueId);
  const result = await f.native.pool.query<{
    source_candidate_count: string;
    mode: 'whole' | 'selection';
    input_version: string;
    input_frozen_version: string | null;
    target_count: string;
    candidate_page_count: string;
    stage_seal_count: string;
    expected_publication_id: string | null;
  }>(
    `SELECT stage.candidate_count::text AS source_candidate_count,stage.mode,
       stage.input_version::text,stage.input_frozen_version::text,
       (SELECT count(*)::text FROM content.hosted_publication_staging_target target
        WHERE target.route=stage.route AND target.catalogue_id=stage.catalogue_id AND target.stage_id=stage.stage_id) AS target_count,
       (SELECT count(*)::text FROM content.hosted_version_release_candidate_page page
        WHERE page.route=stage.route AND page.catalogue_id=stage.catalogue_id AND page.stage_id=stage.stage_id) AS candidate_page_count,
       (SELECT count(*)::text FROM content.hosted_publication_staging_seal seal
        WHERE seal.route=stage.route AND seal.catalogue_id=stage.catalogue_id AND seal.stage_id=stage.stage_id) AS stage_seal_count,
       stage.expected_publication_id
     FROM content.hosted_publication_staging stage
     WHERE stage.route=$1 AND stage.catalogue_id=$2 AND stage.stage_id=$3`,
    [route, f.catalogueId, stageId],
  );
  return result.rows[0]!;
}

async function selectedPointers() {
  const route = routeOf(f.catalogueId);
  const result = await f.native.pool.query<{
    head_revision_id: string;
    publication_id: string | null;
    head_generation_id: string | null;
  }>(
    `SELECT catalogue.head_revision_id,catalogue.publication_id,descriptor.generation_id AS head_generation_id
     FROM content.hosted_catalogue catalogue
     LEFT JOIN content.hosted_version_revision descriptor
       ON descriptor.route=catalogue.route AND descriptor.catalogue_id=catalogue.catalogue_id
      AND descriptor.revision_id=catalogue.head_revision_id
     WHERE catalogue.route=$1 AND catalogue.catalogue_id=$2`,
    [route, f.catalogueId],
  );
  return result.rows[0]!;
}

async function attemptDescriptor(
  generationId: string,
  sequence: string,
  lockTimeout: boolean,
): Promise<unknown | null> {
  const route = routeOf(f.catalogueId);
  const client = await f.native.pool.connect();
  const revisionId = f.newOccurrenceId();
  try {
    await client.query('BEGIN');
    if (lockTimeout) await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query(
      `INSERT INTO content.hosted_structure_revision
         (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,'publication',$4,$5,$6)`,
      [route, f.catalogueId, revisionId, (await selectedPointers()).head_revision_id, f.newOccurrenceId(), new Date()],
    );
    await client.query(
      `INSERT INTO content.hosted_version_revision
         (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
       VALUES ($1,$2,$3,'publication',$4,'candidate',$5)`,
      [route, f.catalogueId, revisionId, generationId, sequence],
    );
    await client.query('COMMIT');
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return error;
  } finally {
    client.release();
  }
}

test('expired stale whole-Book candidate cleanup is fenced, replayable and bounded', async () => {
  const { locator, target, sourceHead, expectedPublicationId, generationId, generationSequence } =
    await createSealedCandidate();
  const route = routeOf(f.catalogueId);
  if (route === null) throw new Error('Hosted fixture catalogue has no route');

  const staleHead = await f.native.command(
    `/v1/hostedCatalogues/${f.catalogueId}:appendRootChapter`,
    {
      expectedRevisionId: sourceHead.revisionId,
      occurrenceId: f.newOccurrenceId(),
      title: 'The source moved after preparation',
      target,
    },
    200,
  );

  const wrongOwner = { ...f.native.author.actor, authnEpoch: f.native.author.actor.authnEpoch + 1 };
  await expect(
    transaction((client) => advanceHostedVersionCandidateCleanup(client, wrongOwner, locator, f.newOccurrenceId())),
  ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupNotFoundError);
  await expect(
    transaction((client) =>
      advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
    ),
  ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupConflictError);

  const liveGeneration = (
    await f.native.pool.query<{ generation_id: string }>(
      `SELECT generation_id FROM content.hosted_version_revision
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
      [route, f.catalogueId, staleHead.revisionId],
    )
  ).rows[0]!.generation_id;
  const retainedBefore = await generationState(liveGeneration);
  const retainedRowsBefore = await generationHasRows(liveGeneration);
  const sourceRowsBefore = await stageRows(locator.stageId);
  const pointersBefore = await selectedPointers();
  expect(pointersBefore).toMatchObject({
    head_revision_id: staleHead.revisionId,
    publication_id: expectedPublicationId,
    head_generation_id: liveGeneration,
  });
  expect(sourceRowsBefore).toMatchObject({
    source_candidate_count: '513',
    expected_publication_id: expectedPublicationId,
  });

  // The fixture records the terminal expiry transition. The stage binding and exact source seal stay immutable.
  await transaction((client) =>
    client.query(
      `UPDATE content.hosted_publication_staging SET status='expired'
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='sealed'`,
      [route, locator.catalogueId, locator.stageId],
    ),
  );

  const firstStepId = f.newOccurrenceId();
  const firstClient = await f.native.pool.connect();
  try {
    await firstClient.query('BEGIN');
    await advanceHostedVersionCandidateCleanup(firstClient, f.native.author.actor, locator, firstStepId);

    const blockedDescriptor = await attemptDescriptor(generationId, generationSequence, true);
    expect(blockedDescriptor).toMatchObject({ code: '55P03' });
    await firstClient.query('COMMIT');
  } catch (error) {
    await firstClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    firstClient.release();
  }

  const descriptorAfterClaim = await attemptDescriptor(generationId, generationSequence, false);
  expect(descriptorAfterClaim).toMatchObject({ code: '23514' });
  expect(String((descriptorAfterClaim as Error).message)).toContain('being retired');

  await expect(
    transaction(async (client) => {
      const snapshot = await readHostedVersionHead(client, f.catalogueId, generationId);
      if (!snapshot) throw new Error('Claimed candidate head was not retained during its first cleanup page');
      const write = createHostedVersionWrite<Record<string, never>>(client, snapshot);
      await commitHostedVersionWrite(client, write);
    }),
  ).rejects.toThrow('Hosted version head cannot advance after retirement');

  const replay = await transaction((client) =>
    advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, firstStepId),
  );
  expect(replay).toMatchObject({
    replayed: true,
    deletedRows: HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT,
    progress: { generationId, phase: 'nodes', completed: false },
  });

  let progress = replay.progress;
  const pages = [replay];
  while (!progress.completed) {
    const page = await transaction((client) =>
      advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
    );
    expect(page.deletedRows).toBeLessThanOrEqual(HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT);
    pages.push(page);
    progress = page.progress;
  }

  expect(pages.length).toBeGreaterThan(3);
  expect(pages.reduce((total, page) => total + page.deletedRows, 0)).toBe(Number(progress.deletedRowCount));
  expect(progress).toMatchObject({ generationId, phase: 'done', completed: true });
  expect(await generationHasRows(generationId)).toEqual({
    generation: false,
    node: false,
    occurrence: false,
    sibling_root: false,
    snapshot: false,
  });
  expect(await generationState(liveGeneration)).toEqual(retainedBefore);
  expect(await generationHasRows(liveGeneration)).toEqual(retainedRowsBefore);
  expect(await selectedPointers()).toEqual(pointersBefore);
  expect(await stageRows(locator.stageId)).toEqual(sourceRowsBefore);

  const terminal = await f.native.pool.query(
    `SELECT status,generation_id FROM content.hosted_version_release_candidate
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, locator.catalogueId, locator.stageId],
  );
  expect(terminal.rows[0]).toEqual({ status: 'reclaimed', generation_id: null });
});

test.each(['expired', 'cancelled'] as const)(
  '%s selected Book candidate cleanup binds its frozen seal and reclaims only unpinned generations',
  async (terminalStatus) => {
    const sharedFixture = f;
    f = await hostedChaptersFixture();
    try {
      const {
        locator,
        target,
        sourceHead,
        expectedPublicationId,
        generationId,
        generationSequence,
        stagingPages,
        candidatePages,
      } = await createSealedCandidate('selection');
      expect(stagingPages).toBeGreaterThan(1);
      expect(candidatePages).toBeGreaterThan(1);

      const staleHead = await f.native.command(
        `/v1/hostedCatalogues/${f.catalogueId}:appendRootChapter`,
        {
          expectedRevisionId: sourceHead.revisionId,
          occurrenceId: f.newOccurrenceId(),
          title: 'The source moved after selection preparation',
          target,
        },
        200,
      );
      const route = routeOf(f.catalogueId);
      if (route === null) throw new Error('Hosted fixture catalogue has no route');
      const liveGeneration = (
        await f.native.pool.query<{ generation_id: string }>(
          `SELECT generation_id FROM content.hosted_version_revision
           WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
          [route, f.catalogueId, staleHead.revisionId],
        )
      ).rows[0]!.generation_id;
      const retainedBefore = await generationState(liveGeneration);
      const retainedRowsBefore = await generationHasRows(liveGeneration);
      const candidateBefore = await generationState(generationId);
      const candidateRowsBefore = await generationHasRows(generationId);
      const sourceRowsBefore = await stageRows(locator.stageId);
      const pointersBefore = await selectedPointers();
      expect(sourceRowsBefore).toMatchObject({
        source_candidate_count: '513',
        mode: 'selection',
        input_frozen_version: sourceRowsBefore.input_version,
        expected_publication_id: expectedPublicationId,
      });

      await expect(
        transaction((client) =>
          advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
        ),
      ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupConflictError);
      expect(await generationState(generationId)).toEqual(candidateBefore);
      expect(await generationHasRows(generationId)).toEqual(candidateRowsBefore);

      if (terminalStatus === 'cancelled') {
        await transaction((client) => cancelHostedPublicationStaging(client, f.native.author.actor, locator));
        await expect(
          transaction((client) =>
            advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
          ),
        ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupConflictError);
        expect(await generationState(generationId)).toEqual(candidateBefore);
        expect(await generationHasRows(generationId)).toEqual(candidateRowsBefore);
        // Move the fixture deadline past without relabelling the cancellation or sleeping.
        await transaction((client) =>
          client.query(
            `UPDATE content.hosted_publication_staging SET expires_at=clock_timestamp()-interval '1 microsecond'
             WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='cancelled'`,
            [route, f.catalogueId, locator.stageId],
          ),
        );
      } else {
        await transaction((client) =>
          client.query(
            `UPDATE content.hosted_publication_staging SET status='expired'
             WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND status='sealed'`,
            [route, f.catalogueId, locator.stageId],
          ),
        );
      }

      await transaction((client) =>
        client.query(
          `UPDATE content.hosted_version_release_candidate SET mode='whole'
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, f.catalogueId, locator.stageId],
        ),
      );
      await expect(
        transaction((client) =>
          advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
        ),
      ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupConflictError);
      expect(await generationState(generationId)).toEqual(candidateBefore);
      expect(await generationHasRows(generationId)).toEqual(candidateRowsBefore);
      await transaction((client) =>
        client.query(
          `UPDATE content.hosted_version_release_candidate SET mode='selection'
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, f.catalogueId, locator.stageId],
        ),
      );

      await transaction((client) =>
        client.query(
          `UPDATE content.hosted_publication_staging SET input_frozen_version=input_version-1
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, f.catalogueId, locator.stageId],
        ),
      );
      await expect(
        transaction((client) =>
          advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
        ),
      ).rejects.toBeInstanceOf(HostedVersionCandidateCleanupConflictError);
      expect(await generationState(generationId)).toEqual(candidateBefore);
      await transaction((client) =>
        client.query(
          `UPDATE content.hosted_publication_staging SET input_frozen_version=input_version
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, f.catalogueId, locator.stageId],
        ),
      );

      const pinClient = await f.native.pool.connect();
      try {
        await pinClient.query('BEGIN');
        await pinClient.query('SAVEPOINT temporary_candidate_pin');
        const revisionId = f.newOccurrenceId();
        await pinClient.query(
          `INSERT INTO content.hosted_structure_revision
             (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
           VALUES ($1,$2,$3,'publication',$4,$5,$6)`,
          [route, f.catalogueId, revisionId, pointersBefore.head_revision_id, f.newOccurrenceId(), new Date()],
        );
        await pinClient.query(
          `INSERT INTO content.hosted_version_revision
             (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
           VALUES ($1,$2,$3,'publication',$4,'candidate',$5)`,
          [route, f.catalogueId, revisionId, generationId, generationSequence],
        );
        let pinConflict: unknown;
        try {
          await advanceHostedVersionCandidateCleanup(pinClient, f.native.author.actor, locator, f.newOccurrenceId());
        } catch (error) {
          pinConflict = error;
        }
        expect(pinConflict).toBeInstanceOf(HostedVersionCandidateCleanupConflictError);
        expect(String((pinConflict as Error).message)).toContain('retained by retained revision');
        await pinClient.query('ROLLBACK TO SAVEPOINT temporary_candidate_pin');
        await pinClient.query('COMMIT');
      } catch (error) {
        await pinClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        pinClient.release();
      }
      expect(await generationState(generationId)).toEqual(candidateBefore);
      expect(await generationHasRows(generationId)).toEqual(candidateRowsBefore);

      const firstStepId = f.newOccurrenceId();
      const firstPage = await transaction(async (client) => {
        const result = await advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, firstStepId);
        const blockedDescriptor = await attemptDescriptor(generationId, generationSequence, true);
        expect(blockedDescriptor).toMatchObject({ code: '55P03' });
        return result;
      });
      expect(firstPage).toMatchObject({
        replayed: false,
        deletedRows: HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT,
        progress: { generationId, terminalStatus, phase: 'nodes', completed: false },
      });

      const descriptorAfterClaim = await attemptDescriptor(generationId, generationSequence, false);
      expect(descriptorAfterClaim).toMatchObject({ code: '23514' });
      const replay = await transaction((client) =>
        advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, firstStepId),
      );
      expect(replay).toMatchObject({
        replayed: true,
        deletedRows: HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT,
        progress: { generationId, terminalStatus, phase: 'nodes', completed: false },
      });

      let progress = replay.progress;
      const pages = [replay];
      while (!progress.completed) {
        const page = await transaction((client) =>
          advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, f.newOccurrenceId()),
        );
        expect(page.deletedRows).toBeLessThanOrEqual(HOSTED_VERSION_CANDIDATE_CLEANUP_STEP_LIMIT);
        pages.push(page);
        progress = page.progress;
      }
      expect(pages.length).toBeGreaterThan(3);
      expect(pages.reduce((total, page) => total + page.deletedRows, 0)).toBe(Number(progress.deletedRowCount));
      expect(progress).toMatchObject({ generationId, terminalStatus, phase: 'done', completed: true });
      const completedReplay = await transaction((client) =>
        advanceHostedVersionCandidateCleanup(client, f.native.author.actor, locator, firstStepId),
      );
      expect(completedReplay).toEqual({ ...firstPage, replayed: true });
      const claim = await f.native.pool.query(
        `SELECT stage.status,cleanup.terminal_status,cleanup.completed_at IS NOT NULL AS completed
         FROM content.hosted_publication_staging stage
         JOIN content.hosted_version_candidate_cleanup cleanup USING (route,catalogue_id,stage_id)
         WHERE stage.route=$1 AND stage.catalogue_id=$2 AND stage.stage_id=$3`,
        [route, f.catalogueId, locator.stageId],
      );
      expect(claim.rows[0]).toEqual({ status: terminalStatus, terminal_status: terminalStatus, completed: true });
      expect(await generationHasRows(generationId)).toEqual({
        generation: false,
        node: false,
        occurrence: false,
        sibling_root: false,
        snapshot: false,
      });
      expect(await generationState(liveGeneration)).toEqual(retainedBefore);
      expect(await generationHasRows(liveGeneration)).toEqual(retainedRowsBefore);
      expect(await selectedPointers()).toEqual(pointersBefore);
      expect(await stageRows(locator.stageId)).toEqual(sourceRowsBefore);
      const terminal = await f.native.pool.query(
        `SELECT status,generation_id,mode FROM content.hosted_version_release_candidate
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [route, f.catalogueId, locator.stageId],
      );
      expect(terminal.rows[0]).toEqual({ status: 'reclaimed', generation_id: null, mode: 'selection' });
    } finally {
      await f?.close();
      f = sharedFixture;
    }
  },
);
