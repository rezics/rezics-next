import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  freezeHostedPublicationSelection,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  sealHostedVersionReleaseCandidate,
} from '../../src/content/hosted-version-release-candidate.ts';
import type { HostedVersionReleaseCandidateValue } from '../../src/content/hosted-version-release-candidate-model.ts';
import {
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
} from '../../src/content/hosted-version-store.ts';
import { selectVersionedOutlineSequenceNode } from '../../src/content/versioned-outline-sequence.ts';
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

async function selectedReleaseId(): Promise<string | null> {
  const route = routeOf(f.catalogueId);
  const row = (
    await f.native.pool.query<{ publication_id: string | null }>(
      `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
      [route, f.catalogueId],
    )
  ).rows[0];
  return row?.publication_id ?? null;
}

test('sparse sealed selection builds a private ordered candidate, replays interruption, and keeps the old release selected', async () => {
  const { path, target, placements, created, published } = await hostedRootAppendBase(f);
  const skippedId = f.newOccurrenceId();
  const selectedId = f.newOccurrenceId();
  const firstAppend = await f.native.command(
    `${path}:appendRootChapter`,
    { expectedRevisionId: created.revisionId, occurrenceId: skippedId, title: 'Skipped source row', target },
    200,
  );
  const secondAppend = await f.native.command(
    `${path}:appendRootChapter`,
    { expectedRevisionId: firstAppend.revisionId, occurrenceId: selectedId, title: 'Selected source row', target },
    200,
  );
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId: secondAppend.revisionId,
      expectedPublicationId: published.revisionId,
      mode: 'selection',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }),
  );
  const selection = [...placements.map((placement) => placement.occurrenceId), selectedId];
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...locator,
      batchId: f.newOccurrenceId(),
      occurrenceIds: selection.slice(0, 512),
    }),
  );
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...locator,
      batchId: f.newOccurrenceId(),
      occurrenceIds: selection.slice(512),
    }),
  );
  let stage = await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, locator));
  while (stage.state !== 'ready') {
    stage = (
      await transaction((client) =>
        advanceHostedPublicationStaging(
          dependencies(),
          client,
          f.native.author.actor,
          locator,
          f.newOccurrenceId(),
          Date.now() + 120_000,
        ),
      )
    ).progress;
  }
  expect(stage).toMatchObject({ candidateCount: '513', settledInputCount: '513', closureMissingCount: '0' });
  const sourceSeal = (
    await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, locator))
  ).seal;
  const begun = await transaction((client) =>
    beginHostedVersionReleaseCandidate(client, f.native.author.actor, sourceSeal),
  );
  expect(begun).toMatchObject({
    replayed: false,
    checkpoint: { placementCount: '0', coverageComplete: false, sourceSeal },
    snapshot: { generationKind: 'candidate', placementCount: 0n, chapterCount: 0n },
  });

  await expect(
    transaction(async (client) => {
      await applyHostedVersionReleaseCandidatePage(client, f.native.author.actor, sourceSeal, null);
      throw new Error('simulated worker crash before commit');
    }),
  ).rejects.toThrow('simulated worker crash');
  const firstPage = await transaction((client) =>
    applyHostedVersionReleaseCandidatePage(client, f.native.author.actor, sourceSeal, null),
  );
  const replay = await transaction((client) =>
    applyHostedVersionReleaseCandidatePage(client, f.native.author.actor, sourceSeal, null),
  );
  expect(firstPage).toMatchObject({ replayed: false, processed: 20, checkpoint: { placementCount: '20' } });
  expect(replay).toMatchObject({ replayed: true, processed: 20 });
  expect(replay.snapshot.sequence).toBe(firstPage.snapshot.sequence);

  let progress = firstPage;
  while (!progress.checkpoint.coverageComplete) {
    progress = await transaction((client) =>
      applyHostedVersionReleaseCandidatePage(
        client,
        f.native.author.actor,
        sourceSeal,
        progress.checkpoint.afterSourceOrder,
      ),
    );
    expect(progress.processed).toBeLessThanOrEqual(20);
  }
  expect(progress.checkpoint).toMatchObject({
    afterSourceOrder: '513',
    placementCount: '513',
    rootCount: '498',
    chapterCount: '497',
    coverageComplete: true,
  });
  expect(progress.snapshot).toMatchObject({ placementCount: 513n, chapterCount: 497n });

  const lastSelectedRoot = await transaction(async (client) => {
    const root = await readHostedVersionSiblingRoot(client, progress.snapshot, null);
    const write = createHostedVersionWrite<HostedVersionReleaseCandidateValue>(client, progress.snapshot);
    return root?.rootNodeId === null || root === null
      ? null
      : selectVersionedOutlineSequenceNode(hostedVersionSequence(write, 'sibling'), root.rootNodeId, 497n);
  });
  expect(lastSelectedRoot?.id).toBe(selectedId);
  const selectedOccurrence = await transaction((client) =>
    readHostedVersionOccurrence<HostedVersionReleaseCandidateValue>(client, progress.snapshot, selectedId),
  );
  expect(selectedOccurrence).toMatchObject({
    parentOccurrenceId: null,
    subtreeSize: 1n,
    value: { kind: 'chapter', title: 'Selected source row', target },
  });

  const candidate = await transaction((client) =>
    sealHostedVersionReleaseCandidate(client, f.native.author.actor, sourceSeal),
  );
  expect(candidate).toMatchObject({
    replayed: false,
    candidate: {
      sourceSeal,
      snapshot: { generationKind: 'candidate', placementCount: 513n, chapterCount: 497n },
      coverage: {
        sourceCandidateCount: '513',
        placementCount: '513',
        rootCount: '498',
        chapterCount: '497',
        complete: true,
      },
    },
  });
  expect(await selectedReleaseId()).toBe(published.revisionId);

  await f.native.command(
    `${path}:appendRootChapter`,
    {
      expectedRevisionId: secondAppend.revisionId,
      occurrenceId: f.newOccurrenceId(),
      title: 'Changed source fence',
      target,
    },
    200,
  );
  await expect(
    transaction((client) => applyHostedVersionReleaseCandidatePage(client, f.native.author.actor, sourceSeal, null)),
  ).rejects.toMatchObject({ code: 'stale-source' });
  expect(await selectedReleaseId()).toBe(published.revisionId);
});
