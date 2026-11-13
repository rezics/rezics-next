import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import type { HostedChapterTarget, OrderedHostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import {
  captureHostedPublicBaselineInput,
  readHostedPublicBaselineInputPage,
} from '../../src/content/hosted-public-baseline-input.ts';
import {
  applyHostedPublicBaselineBuildPage,
  beginHostedPublicBaselineBuild,
  sealHostedPublicBaselineBuild,
} from '../../src/content/hosted-public-baseline-build.ts';
import {
  applyHostedVersionPublicBaselinePage,
  beginHostedVersionPublicBaseline,
  completeHostedVersionPublicBaseline,
  HostedVersionPublicBaselineError,
} from '../../src/content/hosted-version-public-baseline.ts';
import { commitHostedVersionPublicationPoint } from '../../src/content/hosted-version-publication-write.ts';
import type { HostedVersionPublicationStoredValue } from '../../src/content/hosted-version-publication-write-model.ts';
import {
  createHostedVersionWrite,
  hostedVersionSequence,
  readHostedVersionOccurrence,
  readHostedVersionSiblingRoot,
} from '../../src/content/hosted-version-store.ts';
import { rankVersionedOutlineSequenceNode } from '../../src/content/versioned-outline-sequence.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

const context = () => ({
  deadline: Date.now() + 120_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});

function dependencies(fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>): HostedCommandDependencies {
  return {
    pool: fixture.native.pool,
    access: fixture.native.system.access,
    tokens: fixture.native.system.tokenKeys,
    routeKey: fixture.native.system.routeKey,
    clock: () => new Date(),
  };
}

async function transaction<T>(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  work: (tx: any) => Promise<T>,
): Promise<T> {
  const tx = await fixture.native.pool.connect();
  await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

async function publish(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  placements: readonly Record<string, unknown>[],
) {
  const path = `/v1/hostedCatalogues/${fixture.catalogueId}`;
  const created = await fixture.native.command('/v1/hostedCatalogues', {
    postId: fixture.catalogueId,
    threadId: fixture.threadId,
    placements,
  });
  const released = await fixture.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: placements.map((placement) => placement.occurrenceId),
    },
    200,
  );
  return { headId: created.revisionId as string, publicationId: released.revisionId as string };
}

async function pointers(fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>) {
  return (
    await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    )
  ).rows[0]!;
}

test('receives a sealed legacy publication in replayable pages for its first point publication', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const publicTarget = fixture.target(await fixture.native.thread('published'));
    const protectedResponse = await fixture.native.call(
      'POST',
      '/v1/threads',
      {
        title: 'Private public-baseline target',
        body: fromPlainText('Never read by baseline receiving'),
        licence: 'MIT',
        subjectIds: [],
        boardId: fixture.native.board.id,
        visibility: 'protected',
      },
      { other: true },
    );
    expect(protectedResponse.status).toBe(201);
    const protectedTarget = fixture.target(protectedResponse.value.thread as never);
    const partId = fixture.newOccurrenceId();
    const visibleChildId = fixture.newOccurrenceId();
    const topLevelIds = Array.from({ length: 19 }, () => fixture.newOccurrenceId());
    const unavailableId = fixture.newOccurrenceId();
    const placements: Record<string, unknown>[] = [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Public section', kind: 'part' },
      {
        occurrenceId: visibleChildId,
        parentId: partId,
        position: 0,
        title: 'Public nested chapter',
        kind: 'chapter',
        target: publicTarget,
      },
      ...topLevelIds.map((occurrenceId, index) => ({
        occurrenceId,
        parentId: null,
        position: index + 1,
        title: `Public chapter ${index}`,
        kind: 'chapter',
        target: publicTarget,
      })),
      {
        occurrenceId: unavailableId,
        parentId: null,
        position: 20,
        title: 'Unavailable chapter',
        kind: 'chapter',
        target: protectedTarget,
      },
    ];
    const original = await publish(fixture, placements);
    const newChapterId = fixture.newOccurrenceId();
    const draftPlacements = [
      ...placements.map((placement) => ({
        ...placement,
        title: `${String(placement.title)} changed in private draft`,
      })),
      {
        occurrenceId: newChapterId,
        parentId: null,
        position: 21,
        title: 'Private chapter to publish',
        kind: 'chapter',
        target: publicTarget,
      },
    ];
    const revised = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:revise`,
      { expectedRevisionId: original.headId, placements: draftPlacements },
      200,
    );

    const deps = dependencies(fixture);
    const captured = await captureHostedPublicBaselineInput(
      deps,
      fixture.native.author.actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
      context(),
    );
    let builderState = await transaction(fixture, (tx) => beginHostedPublicBaselineBuild(tx, captured.value));
    let finalBuilderPage: Parameters<typeof sealHostedPublicBaselineBuild>[1] | null = null;
    while (finalBuilderPage === null) {
      const result = await readHostedPublicBaselineInputPage(
        deps,
        fixture.native.author.actor,
        builderState.source,
        { frontier: builderState.frontier, limit: 20 },
        context(),
      );
      const page = { buildId: builderState.buildId, fromFrontier: builderState.frontier, result };
      await transaction(fixture, (tx) => applyHostedPublicBaselineBuildPage(tx, page));
      if (result.coverage.complete) finalBuilderPage = page;
      builderState = await transaction(fixture, (tx) => beginHostedPublicBaselineBuild(tx, captured.value));
    }
    const sealed = await transaction(fixture, (tx) => sealHostedPublicBaselineBuild(tx, finalBuilderPage!));
    expect(sealed.placementCount).toBe(22n);
    expect(sealed.chapterCount).toBe(21n);
    expect((await pointers(fixture)).publication_id).toBe(original.publicationId);

    let receiving = await transaction(fixture, (tx) => beginHostedVersionPublicBaseline(tx, sealed));
    expect(receiving.actorBinding).toBe(sealed.source.actorBinding);
    expect(receiving.sourcePublicationId).toBe(original.publicationId);
    const interruptedCursor = receiving.cursor;
    await expect(
      transaction(fixture, async (tx) => {
        await applyHostedVersionPublicBaselinePage(tx, fixture.catalogueId, sealed.buildId, interruptedCursor);
        throw new Error('simulated worker interruption');
      }),
    ).rejects.toThrow('simulated worker interruption');
    const afterInterruption = await transaction(fixture, (tx) => beginHostedVersionPublicBaseline(tx, sealed));
    expect(afterInterruption.cursor).toEqual(interruptedCursor);
    expect((await pointers(fixture)).publication_id).toBe(original.publicationId);

    const firstPage = await transaction(fixture, (tx) =>
      applyHostedVersionPublicBaselinePage(tx, fixture.catalogueId, sealed.buildId, interruptedCursor),
    );
    expect(firstPage.replayed).toBe(false);
    expect(firstPage.work.occurrencesWritten).toBe(20);
    expect(
      firstPage.work.occurrencesWritten + firstPage.work.nodesWritten + firstPage.work.siblingRootsWritten,
    ).toBeLessThanOrEqual(20);
    const replay = await transaction(fixture, (tx) =>
      applyHostedVersionPublicBaselinePage(tx, fixture.catalogueId, sealed.buildId, interruptedCursor),
    );
    expect(replay.replayed).toBe(true);
    receiving = await transaction(fixture, (tx) => beginHostedVersionPublicBaseline(tx, sealed));
    expect(receiving.cursor).toEqual(firstPage.state.cursor);

    while (receiving.status !== 'complete') {
      const page = await transaction(fixture, (tx) =>
        applyHostedVersionPublicBaselinePage(tx, fixture.catalogueId, sealed.buildId, receiving.cursor),
      );
      expect(page.work.occurrencesWritten + page.work.nodesWritten + page.work.siblingRootsWritten).toBeLessThanOrEqual(
        20,
      );
      receiving = page.state;
      expect((await pointers(fixture)).publication_id).toBe(original.publicationId);
    }
    expect(receiving.occurrencesWritten).toBe(22n);
    expect(receiving.nodesWritten).toBe(65n);
    const baseline = await transaction(fixture, (tx) =>
      completeHostedVersionPublicBaseline(tx, fixture.catalogueId, sealed.buildId),
    );
    expect(baseline).toMatchObject({ sourcePublicationId: original.publicationId });
    expect(baseline.snapshot).toMatchObject({
      generationKind: 'candidate',
      placementCount: 22n,
      chapterCount: 21n,
      preorderRootId: sealed.preorderRootId,
      chapterRootId: sealed.chapterRootId,
    });
    const storedVisible = await readHostedVersionOccurrence<HostedVersionPublicationStoredValue>(
      fixture.native.pool,
      baseline.snapshot,
      visibleChildId,
    );
    expect(storedVisible?.value).toEqual({
      kind: 'chapter',
      title: 'Public nested chapter',
      target: publicTarget,
      chapterCount: 1n,
    });
    const storedUnavailable = await readHostedVersionOccurrence<HostedVersionPublicationStoredValue>(
      fixture.native.pool,
      baseline.snapshot,
      unavailableId,
    );
    expect(storedUnavailable?.value).toEqual({ kind: 'chapter', title: null, target: null, chapterCount: 1n });
    const oldNestedRoot = await readHostedVersionSiblingRoot(fixture.native.pool, baseline.snapshot, partId);
    expect(oldNestedRoot?.rootNodeId).toBe(visibleChildId);

    const anchorId = topLevelIds[5]!;
    const anchor: OrderedHostedPlacement = {
      occurrenceId: anchorId,
      parentId: null,
      position: 6,
      ordinal: 7,
      kind: 'chapter',
      title: 'Public chapter 5',
      target: publicTarget,
    };
    const selected: OrderedHostedPlacement = {
      occurrenceId: newChapterId,
      parentId: null,
      position: 21,
      ordinal: 22,
      kind: 'chapter',
      title: 'Private chapter to publish',
      target: publicTarget,
    };
    const pointRevisionId = fixture.newOccurrenceId();
    const point = await transaction(fixture, (tx) =>
      commitHostedVersionPublicationPoint(tx, {
        catalogueId: fixture.catalogueId,
        revisionId: pointRevisionId,
        recordedTransactionId: fixture.newOccurrenceId(),
        recordedAt: new Date().toISOString(),
        selection: {
          kind: 'publishChapter',
          expectedRevisionId: revised.revisionId as string,
          expectedPublicationId: original.publicationId,
          chapter: selected,
          ancestors: [],
          parentId: null,
          beforeOccurrenceId: anchorId,
          parent: null,
          before: anchor,
          changedPlacements: [selected],
        },
        preparedBaseline: baseline,
      }),
    );
    expect(point.plan.insertions[0]).toMatchObject({
      occurrenceId: newChapterId,
      siblingRank: 6n,
      preorderRank: 7n,
    });
    const nextWrite = createHostedVersionWrite<HostedVersionPublicationStoredValue>(
      fixture.native.pool,
      point.snapshot,
    );
    const newRank = await rankVersionedOutlineSequenceNode(
      hostedVersionSequence(nextWrite, 'preorder'),
      point.snapshot.preorderRootId,
      newChapterId,
    );
    expect(newRank).toBe(7n);
    expect((await readHostedVersionSiblingRoot(fixture.native.pool, point.snapshot, partId))?.rootNodeId).toBe(
      oldNestedRoot?.rootNodeId,
    );
    expect((await pointers(fixture)).publication_id).toBe(pointRevisionId);
    await expect(
      transaction(fixture, (tx) =>
        applyHostedVersionPublicBaselinePage(tx, fixture.catalogueId, sealed.buildId, interruptedCursor),
      ),
    ).rejects.toMatchObject({ code: 'stale-source' } satisfies Partial<HostedVersionPublicBaselineError>);
    await expect(
      transaction(fixture, (tx) => completeHostedVersionPublicBaseline(tx, fixture.catalogueId, sealed.buildId)),
    ).rejects.toMatchObject({ code: 'stale-source' } satisfies Partial<HostedVersionPublicBaselineError>);
  } finally {
    await fixture.native.close();
  }
});
