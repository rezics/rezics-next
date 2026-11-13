import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import {
  captureHostedPublicBaselineInput,
  readHostedPublicBaselineInputPage,
} from '../../src/content/hosted-public-baseline-input.ts';
import {
  applyHostedPublicBaselineBuildPage,
  beginHostedPublicBaselineBuild,
  sealHostedPublicBaselineBuild,
} from '../../src/content/hosted-public-baseline-build.ts';
import { HostedVersionBuilderError } from '../../src/content/hosted-version-builder-model.ts';
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

test('resumes exact public ordinal pages and seals the old manifest beside a newer private draft', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread('published'));
    const privateResponse = await fixture.native.call(
      'POST',
      '/v1/threads',
      {
        title: 'Private target',
        body: fromPlainText('Private target body'),
        licence: 'MIT',
        subjectIds: [],
        boardId: fixture.native.board.id,
        visibility: 'protected',
      },
      { other: true },
    );
    expect(privateResponse.status).toBe(201);
    const unavailableTarget = fixture.target(privateResponse.value.thread as never);
    const partId = fixture.newOccurrenceId();
    const availableId = fixture.newOccurrenceId();
    const secondPartId = fixture.newOccurrenceId();
    const unavailableId = fixture.newOccurrenceId();
    const privateDraftId = fixture.newOccurrenceId();
    const original = await publish(fixture, [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Public section', kind: 'part' },
      { occurrenceId: availableId, parentId: partId, position: 0, title: 'Public chapter', kind: 'chapter', target },
      { occurrenceId: secondPartId, parentId: null, position: 1, title: 'Second section', kind: 'part' },
      {
        occurrenceId: unavailableId,
        parentId: secondPartId,
        position: 0,
        title: 'Hidden chapter',
        kind: 'chapter',
        target: unavailableTarget,
      },
    ]);

    const revised = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:revise`,
      {
        expectedRevisionId: original.headId,
        placements: [
          { occurrenceId: partId, parentId: null, position: 0, title: 'Private section edit', kind: 'part' },
          {
            occurrenceId: availableId,
            parentId: partId,
            position: 0,
            title: 'Private chapter edit',
            kind: 'chapter',
            target,
          },
          { occurrenceId: secondPartId, parentId: null, position: 1, title: 'Second section', kind: 'part' },
          {
            occurrenceId: unavailableId,
            parentId: secondPartId,
            position: 0,
            title: 'Hidden chapter',
            kind: 'chapter',
            target: unavailableTarget,
          },
          { occurrenceId: privateDraftId, parentId: null, position: 2, title: 'Draft only', kind: 'part' },
        ],
      },
      200,
    );
    expect(revised.revisionId).not.toBe(original.headId);

    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
      context(),
    );
    let state = await transaction(fixture, (tx) => beginHostedPublicBaselineBuild(tx, captured.value));
    expect(state.source).toEqual(captured.value.source);
    expect(state.frontier).toEqual({ afterOrdinal: -1 });

    const firstPage = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      state.source,
      { frontier: state.frontier, limit: 2 },
      context(),
    );
    expect(firstPage.items.map((item) => item.occurrenceId)).toEqual([partId, availableId]);
    const firstBuildPage = { buildId: state.buildId, fromFrontier: state.frontier, result: firstPage };
    const appliedFirst = await transaction(fixture, (tx) => applyHostedPublicBaselineBuildPage(tx, firstBuildPage));
    expect(appliedFirst.replayed).toBe(false);
    expect(appliedFirst.application?.logicalWork.pointFactsWritten).toBe(2);

    state = await transaction(fixture, (tx) => beginHostedPublicBaselineBuild(tx, captured.value));
    expect(state.buildId).toBe(firstBuildPage.buildId);
    expect(state.frontier).toEqual({ afterOrdinal: 1 });
    const replay = await transaction(fixture, (tx) => applyHostedPublicBaselineBuildPage(tx, firstBuildPage));
    expect(replay.replayed).toBe(true);
    expect(replay.state.frontier).toEqual({ afterOrdinal: 1 });

    const finalPage = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      state.source,
      { frontier: state.frontier, limit: 2 },
      context(),
    );
    expect(finalPage.items.map((item) => item.occurrenceId)).toEqual([secondPartId, unavailableId]);
    expect(finalPage.coverage).toEqual({ visited: 4, expected: 4, complete: true });
    expect(finalPage.items[1]).toMatchObject({ availability: 'unavailable', kind: 'chapter', ordinal: 3 });
    const finalBuildPage = { buildId: state.buildId, fromFrontier: state.frontier, result: finalPage };
    const appliedFinal = await transaction(fixture, (tx) => applyHostedPublicBaselineBuildPage(tx, finalBuildPage));
    expect(appliedFinal.application?.logicalWork.pointFactsWritten).toBe(2);

    const sealed = await transaction(fixture, (tx) => sealHostedPublicBaselineBuild(tx, finalBuildPage));
    expect(sealed).toMatchObject({
      buildId: state.buildId,
      candidateId: state.buildId,
      expectedPublicationId: original.publicationId,
      placementCount: 4n,
      rootCount: 2n,
      chapterCount: 2n,
    });
    expect(sealed.source.actorBinding).toBe(captured.value.source.actorBinding);

    const pointers = await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    );
    expect(pointers.rows[0]).toEqual({ head_revision_id: revised.revisionId, publication_id: original.publicationId });

    const facts = await fixture.native.pool.query<{
      source_ordinal: string;
      occurrence_id: string;
      parent_id: string | null;
      title: string | null;
      target_post_id: string | null;
    }>(
      `SELECT source_ordinal::text,occurrence_id,parent_id,title,target_post_id
       FROM content.hosted_version_builder_point
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 ORDER BY source_ordinal`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, state.buildId],
    );
    expect(facts.rows).toEqual([
      { source_ordinal: '0', occurrence_id: partId, parent_id: null, title: 'Public section', target_post_id: null },
      {
        source_ordinal: '1',
        occurrence_id: availableId,
        parent_id: partId,
        title: 'Public chapter',
        target_post_id: target.postId,
      },
      {
        source_ordinal: '2',
        occurrence_id: secondPartId,
        parent_id: null,
        title: 'Second section',
        target_post_id: null,
      },
      { source_ordinal: '3', occurrence_id: unavailableId, parent_id: secondPartId, title: null, target_post_id: null },
    ]);
    const draftOnly = await fixture.native.pool.query(
      `SELECT 1 FROM content.hosted_version_builder_point
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND occurrence_id=$4`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, state.buildId, privateDraftId],
    );
    expect(draftOnly.rows).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test('a publication changed after complete observation cannot seal the old private candidate', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread('published'));
    const oldId = fixture.newOccurrenceId();
    const original = await publish(fixture, [
      { occurrenceId: oldId, parentId: null, position: 0, title: 'Original', kind: 'chapter', target },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
      context(),
    );
    const state = await transaction(fixture, (tx) => beginHostedPublicBaselineBuild(tx, captured.value));
    const page = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      state.source,
      { frontier: state.frontier, limit: 1 },
      context(),
    );
    expect(page.coverage.complete).toBe(true);
    const buildPage = { buildId: state.buildId, fromFrontier: state.frontier, result: page };
    await transaction(fixture, (tx) => applyHostedPublicBaselineBuildPage(tx, buildPage));

    const nextId = fixture.newOccurrenceId();
    const revised = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:revise`,
      {
        expectedRevisionId: original.headId,
        placements: [
          { occurrenceId: nextId, parentId: null, position: 0, title: 'Replacement', kind: 'chapter', target },
        ],
      },
      200,
    );
    const released = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:publish`,
      {
        expectedRevisionId: revised.revisionId,
        expectedPublicationId: original.publicationId,
        occurrenceIds: [nextId],
      },
      200,
    );
    expect(released.revisionId).not.toBe(original.publicationId);

    await expect(transaction(fixture, (tx) => sealHostedPublicBaselineBuild(tx, buildPage))).rejects.toMatchObject({
      code: 'stale-source',
    } satisfies Partial<HostedVersionBuilderError>);
    const build = await fixture.native.pool.query<{ status: string }>(
      `SELECT status FROM content.hosted_version_builder
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, state.buildId],
    );
    expect(build.rows[0]?.status).toBe('building');
  } finally {
    await fixture.close();
  }
});
