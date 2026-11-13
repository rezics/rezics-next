import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient, QueryResultRow } from 'pg';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  cancelHostedPublicationStaging,
  freezeHostedPublicationSelection,
  readHostedPublicationStagingCandidates,
  readHostedPublicationStagingProgress,
  readHostedPublicationStagingTargetObservations,
  sealHostedPublicationStaging,
} from '../../src/content/hosted-publication-staging.ts';
import type { HostedPublicationStagingLocator } from '../../src/content/hosted-publication-staging-model.ts';
import readChain from '../../src/content/read-chain.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { hostedRootAppendBase } from './support/hosted-root-append-setup.ts';
import { observeSql } from './support/sql-observer.ts';

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

async function begin(
  expectedHeadRevisionId: string,
  expectedPublicationId: string | null,
  mode: 'whole' | 'selection',
): Promise<HostedPublicationStagingLocator> {
  const locator = { catalogueId: f.catalogueId, stageId: f.newOccurrenceId() };
  await transaction((client) =>
    beginHostedPublicationStaging(client, f.native.author.actor, {
      ...locator,
      expectedHeadRevisionId,
      expectedPublicationId,
      mode,
      expiresAt: new Date(Date.now() + 60 * 60_000),
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

async function convertDraft(path: string, expectedRevisionId: string): Promise<string> {
  const conversionPath = `${path}:convertDraft`;
  const capture = await f.native.command(conversionPath, { step: 'capture', expectedRevisionId }, 200);
  const inputId = capture.inputId as string;
  let progress = await f.native.command(conversionPath, { step: 'begin', inputId, expectedRevisionId }, 200);
  while (progress.nextStep === 'page') {
    progress = await f.native.command(
      conversionPath,
      { step: 'page', inputId, expectedRevisionId, cursor: progress.frontier },
      200,
    );
  }
  expect(progress.nextStep).toBe('seal');
  progress = await f.native.command(conversionPath, { step: 'seal', inputId, expectedRevisionId }, 200);
  progress = await f.native.command(conversionPath, { step: 'materialize', inputId, expectedRevisionId }, 200);
  while (progress.nextStep === 'materializePage') {
    progress = await f.native.command(conversionPath, { step: 'materializePage', inputId, expectedRevisionId }, 200);
  }
  expect(progress.nextStep).toBe('commit');
  const committed = await f.native.command(conversionPath, { step: 'commit', inputId, expectedRevisionId }, 200);
  return committed.revisionId as string;
}

function containsId(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (typeof value === 'string') return value.includes(id);
  if (Array.isArray(value)) return value.some((item) => containsId(item, id));
  return false;
}

test('selection streams past 512, replays a rolled-back step, and seals source-ordered exact candidates', async () => {
  const { path, target, placements, created, published } = await hostedRootAppendBase(f);
  const appendedId = f.newOccurrenceId();
  const appended = await f.native.command(
    `${path}:appendRootChapter`,
    {
      expectedRevisionId: created.revisionId,
      occurrenceId: appendedId,
      title: 'After the whole base',
      target,
    },
    200,
  );
  const locator = await begin(appended.revisionId, published.revisionId, 'selection');
  const selected = [...placements.map((placement) => placement.occurrenceId), appendedId].reverse();
  const observer = observeSql(f.native.pool);
  try {
    const firstBatch = {
      ...locator,
      batchId: f.newOccurrenceId(),
      occurrenceIds: selected.slice(0, 512),
    };
    const stored = await transaction((client) =>
      appendHostedPublicationSelectionBatch(client, f.native.author.actor, firstBatch),
    );
    expect(stored).toMatchObject({ replayed: false, itemCount: 512, firstInputPosition: '0' });
    expect(
      await transaction((client) => appendHostedPublicationSelectionBatch(client, f.native.author.actor, firstBatch)),
    ).toMatchObject({ replayed: true, inputVersion: stored.inputVersion });
    await transaction((client) =>
      appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
        ...locator,
        batchId: f.newOccurrenceId(),
        occurrenceIds: selected.slice(512),
      }),
    );
    expect(
      await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, locator)),
    ).toMatchObject({ state: 'building', inputCount: '513', inputVersion: '2' });

    const crashReplayId = f.newOccurrenceId();
    await expect(
      transaction(async (client) => {
        await advanceHostedPublicationStaging(
          dependencies(),
          client,
          f.native.author.actor,
          locator,
          crashReplayId,
          Date.now() + 120_000,
        );
        throw new Error('simulated worker crash before commit');
      }),
    ).rejects.toThrow('simulated worker crash');
    const recovered = await advance(locator, crashReplayId);
    expect(recovered).toMatchObject({ replayed: false, processed: 20, phase: 'selection' });
    expect(await advance(locator, crashReplayId)).toMatchObject({ replayed: true, processed: 20 });

    let progress = recovered.progress;
    while (progress.state !== 'ready') {
      const step = await advance(locator);
      expect(step.progress.state).not.toBe('failed');
      progress = step.progress;
    }
    expect(progress).toMatchObject({ candidateCount: '513', settledInputCount: '513', closureMissingCount: '0' });
    await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, locator));

    const processed = observer.records;
    const bodyReads = processed.filter((record) => record.statement === readChain.sql);
    expect(bodyReads.length).toBeGreaterThan(0);
    for (const read of bodyReads) expect(read.parameters[readChain.params.indexOf('include_body')]).toBe(false);
    const sourceReads = processed.filter((record) =>
      /FROM content\.hosted_(placement|append)\b/.test(record.statement),
    );
    expect(sourceReads.length).toBeGreaterThan(0);
    for (const read of sourceReads) expect(read.statement).toMatch(/occurrence_id=ANY\(/);

    const output = [];
    let cursor: string | null = null;
    do {
      const page = await transaction((client) =>
        readHostedPublicationStagingCandidates(client, f.native.author.actor, locator, cursor),
      );
      output.push(...page.items);
      cursor = page.next;
    } while (cursor !== null);
    expect(output.map((candidate) => candidate.occurrenceId)).toEqual([
      ...placements.map((placement) => placement.occurrenceId),
      appendedId,
    ]);
    expect(output.every((candidate) => candidate.kind === 'part' || candidate.target?.postId === target.postId)).toBe(
      true,
    );
    expect(output.at(-1)).toMatchObject({
      occurrenceId: appendedId,
      sourceOrder: '512',
      sourceSegment: 'append',
      title: 'After the whole base',
      target,
    });
    const observations = await transaction((client) =>
      readHostedPublicationStagingTargetObservations(client, f.native.author.actor, locator, null),
    );
    expect(observations.items).toHaveLength(1);
    expect(observations.items[0]).toMatchObject({
      target,
      authorId: f.native.author.actor.accountId,
      licence: 'MIT',
    });
  } finally {
    await observer.close();
  }
});

test('whole-source staleness, missing ancestors, incomplete selection, empty selection, and cancellation fail closed', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const targetThread = await f.native.thread();
  const target = f.target(targetThread);
  const partId = f.newOccurrenceId();
  const chapterId = f.newOccurrenceId();
  const placements = [
    { occurrenceId: partId, parentId: null, position: 0, title: 'Part', kind: 'part' as const },
    { occurrenceId: chapterId, parentId: partId, position: 0, title: 'Chapter', kind: 'chapter' as const, target },
  ];
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements,
  });
  const stale = await begin(created.revisionId, null, 'whole');
  expect((await advance(stale)).progress).toMatchObject({ state: 'ready', sourceExhausted: true, candidateCount: '2' });
  const revised = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: created.revisionId,
      placements: placements.map((placement) => ({ ...placement, title: `${placement.title} revised` })),
    },
    200,
  );
  await expect(
    transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, stale)),
  ).rejects.toThrow('changed before seal');

  const incomplete = await begin(revised.revisionId, null, 'selection');
  await transaction((client) =>
    appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
      ...incomplete,
      batchId: f.newOccurrenceId(),
      occurrenceIds: [chapterId],
    }),
  );
  await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, incomplete));
  expect((await advance(incomplete)).progress.state).toBe('closing');
  expect((await advance(incomplete)).progress).toMatchObject({ state: 'failed', failure: 'missing_ancestor' });
  await expect(
    transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, incomplete)),
  ).rejects.toThrow('not ready');

  const empty = await begin(revised.revisionId, null, 'selection');
  await expect(
    transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, empty)),
  ).rejects.toThrow('not complete');
  await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, empty));
  expect((await advance(empty)).progress).toMatchObject({ state: 'ready', candidateCount: '0' });
  expect(
    await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, empty)),
  ).toMatchObject({
    replayed: false,
    seal: { candidateCount: '0', mode: 'selection' },
  });
  expect(
    await transaction((client) => readHostedPublicationStagingProgress(client, f.native.author.actor, empty)),
  ).toMatchObject({ state: 'sealed', candidateCount: '0' });

  const cancelled = await begin(revised.revisionId, null, 'whole');
  expect(
    await transaction((client) => cancelHostedPublicationStaging(client, f.native.author.actor, cancelled)),
  ).toMatchObject({ state: 'cancelled' });
  expect(
    await transaction((client) => cancelHostedPublicationStaging(client, f.native.author.actor, cancelled)),
  ).toMatchObject({ state: 'cancelled' });
});

test('ordered staging pages more than 512 placements and keeps sparse candidates pinned across edits and erasure', async () => {
  const book = await hostedRootAppendBase(f);
  const path = book.path;
  const convertedRevisionId = await convertDraft(path, book.created.revisionId);
  const partIds = book.placements.slice(0, 16).map((placement) => placement.occurrenceId);
  const nestedChapterId = f.newOccurrenceId();
  const nested = await f.native.command(
    `${path}:insertDraftPoint`,
    {
      expectedRevisionId: convertedRevisionId,
      occurrenceId: nestedChapterId,
      parentId: partIds.at(-1),
      beforeOccurrenceId: null,
      title: 'Nested ordered chapter',
      placement: { kind: 'chapter', target: book.target },
    },
    200,
  );
  const finalPartId = f.newOccurrenceId();
  const ordered = await f.native.command(
    `${path}:insertDraftPoint`,
    {
      expectedRevisionId: nested.revisionId,
      occurrenceId: finalPartId,
      parentId: null,
      beforeOccurrenceId: null,
      title: 'Final ordered part',
      placement: { kind: 'part' },
    },
    200,
  );
  const placementCount = await transaction(async (client) => {
    const row = (
      await client.query<QueryResultRow & { placement_count: string }>(
        `SELECT snapshot.placement_count::text
         FROM content.hosted_version_revision revision
         JOIN content.hosted_tree_snapshot_version snapshot
           ON snapshot.route=revision.route AND snapshot.catalogue_id=revision.catalogue_id
          AND snapshot.generation_id=revision.generation_id AND snapshot.sequence=revision.sequence
         WHERE revision.route=$1 AND revision.catalogue_id=$2 AND revision.revision_id=$3`,
        [book.route, f.catalogueId, ordered.revisionId],
      )
    ).rows[0];
    return row?.placement_count;
  });
  expect(placementCount).toBe('514');

  const observer = observeSql(f.native.pool);
  try {
    const whole = await begin(ordered.revisionId, book.published.revisionId, 'whole');
    let wholeProgress = await advance(whole);
    while (wholeProgress.progress.state !== 'ready') {
      expect(wholeProgress.processed).toBeLessThanOrEqual(20);
      wholeProgress = await advance(whole);
    }
    expect(wholeProgress.progress).toMatchObject({
      candidateCount: '514',
      sourceExhausted: true,
      state: 'ready',
    });
    const wholeSeal = await transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, whole));
    expect(wholeSeal.seal.sourceRevisionId).toBe(ordered.revisionId);

    const erasedSource = await f.native.thread();
    const erasedTarget = f.target(erasedSource);
    const erasedPlacement = book.placements[200]!;
    const erasedTitle = 'Secret title in the erased slot';
    const updatedErased = await f.native.command(
      `${path}:updateDraftPoint`,
      {
        expectedRevisionId: ordered.revisionId,
        occurrenceId: erasedPlacement.occurrenceId,
        title: erasedTitle,
        target: erasedTarget,
      },
      200,
    );
    await f.native.command(`/v1/posts/${erasedTarget.postId}:erase`, { reason: 'Erase ordered staging slot' }, 200);

    const selectionSourceReadStart = observer.records.length;
    const selection = await begin(updatedErased.revisionId, book.published.revisionId, 'selection');
    const selectedIds = [...partIds, nestedChapterId, book.placements[400]!.occurrenceId, finalPartId];
    await transaction((client) =>
      appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
        ...selection,
        batchId: f.newOccurrenceId(),
        occurrenceIds: selectedIds,
      }),
    );
    await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, selection));
    let selectionProgress = await advance(selection);
    while (selectionProgress.progress.state !== 'ready') selectionProgress = await advance(selection);
    const selectionSeal = await transaction((client) =>
      sealHostedPublicationStaging(client, f.native.author.actor, selection),
    );
    expect(selectionSeal.seal).toMatchObject({ sourceRevisionId: updatedErased.revisionId, candidateCount: '19' });
    const successfulSelectionReads = observer.records.slice(selectionSourceReadStart);
    expect(successfulSelectionReads.some((record) => containsId(record.parameters, erasedPlacement.occurrenceId))).toBe(
      false,
    );

    const erasedSelection = await begin(updatedErased.revisionId, book.published.revisionId, 'selection');
    await transaction((client) =>
      appendHostedPublicationSelectionBatch(client, f.native.author.actor, {
        ...erasedSelection,
        batchId: f.newOccurrenceId(),
        occurrenceIds: [erasedPlacement.occurrenceId],
      }),
    );
    await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, erasedSelection));
    const withheld = await advance(erasedSelection);
    expect(withheld.progress).toMatchObject({ state: 'failed', failure: 'target_unavailable', candidateCount: '0' });
    expect(JSON.stringify(withheld.progress)).not.toContain(erasedTarget.postId);
    expect(JSON.stringify(withheld.progress)).not.toContain(erasedTitle);
    const erasedProgress = await transaction(async (client) => {
      const row = (
        await client.query<QueryResultRow & { candidate_count: string; target_observation_count: string }>(
          `SELECT candidate_count::text,target_observation_count::text
           FROM content.hosted_publication_staging
           WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [book.route, f.catalogueId, erasedSelection.stageId],
        )
      ).rows[0];
      return row;
    });
    expect(erasedProgress).toMatchObject({ candidate_count: '0', target_observation_count: '0' });

    const staleEmpty = await begin(updatedErased.revisionId, book.published.revisionId, 'selection');
    await transaction((client) => freezeHostedPublicationSelection(client, f.native.author.actor, staleEmpty));
    expect((await advance(staleEmpty)).progress.state).toBe('closing');
    expect((await advance(staleEmpty)).progress).toMatchObject({ state: 'ready', candidateCount: '0' });
    const changedAfterPin = await f.native.command(
      `${path}:updateDraftPoint`,
      {
        expectedRevisionId: updatedErased.revisionId,
        occurrenceId: book.placements[400]!.occurrenceId,
        title: 'Changed after staging was sealed',
        target: book.target,
      },
      200,
    );
    expect(changedAfterPin.revisionId).not.toBe(updatedErased.revisionId);
    await expect(
      transaction((client) => sealHostedPublicationStaging(client, f.native.author.actor, staleEmpty)),
    ).rejects.toThrow('changed before seal');

    const selectionOutput = await transaction((client) =>
      readHostedPublicationStagingCandidates(client, f.native.author.actor, selection, null),
    );
    expect(selectionOutput.items.map((item) => item.sourceOrder)).toEqual([
      ...Array.from({ length: 17 }, (_, index) => String(index)),
      '417',
      '513',
    ]);
    expect(selectionOutput.items.map((item) => item.occurrenceId)).toEqual([
      ...partIds,
      nestedChapterId,
      book.placements[400]!.occurrenceId,
      finalPartId,
    ]);
    expect(selectionOutput.items.find((item) => item.occurrenceId === nestedChapterId)).toMatchObject({
      parentId: partIds.at(-1),
      sourceSegment: 'ordered',
      title: 'Nested ordered chapter',
      target: book.target,
    });
    expect(JSON.stringify(selectionOutput.items)).not.toContain(erasedPlacement.occurrenceId);
    expect(JSON.stringify(selectionOutput.items)).not.toContain(erasedTarget.postId);
    expect(JSON.stringify(selectionOutput.items)).not.toContain(erasedTitle);

    const wholePinnedRead = await transaction((client) =>
      readHostedPublicationStagingCandidates(client, f.native.author.actor, whole, '416', 1),
    );
    expect(wholePinnedRead.items).toMatchObject([
      {
        sourceOrder: '417',
        occurrenceId: book.placements[400]!.occurrenceId,
        sourceSegment: 'ordered',
        title: book.placements[400]!.title,
      },
    ]);

    const bodyReads = observer.records.filter((record) => record.statement === readChain.sql);
    expect(bodyReads.length).toBeGreaterThan(0);
    for (const read of bodyReads) expect(read.parameters[readChain.params.indexOf('include_body')]).toBe(false);
  } finally {
    await observer.close();
  }
});
