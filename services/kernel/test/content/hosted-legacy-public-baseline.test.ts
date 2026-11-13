import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

test('prepares and replays a legacy public baseline before the first exact chapter publication', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const legacySource = await fixture.native.thread('published', fromPlainText('Retained legacy chapter'));
    const selectedSource = await fixture.native.thread('published', fromPlainText('First selected chapter'));
    const legacyTarget = fixture.target(legacySource);
    const selectedTarget = fixture.target(selectedSource);
    const oldChapterId = fixture.newOccurrenceId();
    const oldParts = Array.from({ length: 20 }, (_, position) => ({
      occurrenceId: fixture.newOccurrenceId(),
      parentId: null,
      position,
      title: `Legacy part ${position}`,
      kind: 'part' as const,
    }));
    const legacyPlacements = [
      ...oldParts,
      {
        occurrenceId: oldChapterId,
        parentId: null,
        position: oldParts.length,
        title: 'Retained chapter',
        kind: 'chapter' as const,
        target: legacyTarget,
      },
    ];
    const bookPath = `/v1/hostedCatalogues/${fixture.catalogueId}`;
    const created = await fixture.native.command('/v1/hostedCatalogues', {
      postId: fixture.catalogueId,
      threadId: fixture.threadId,
      placements: legacyPlacements,
    });
    const released = await fixture.native.command(
      `${bookPath}:publish`,
      {
        expectedRevisionId: created.revisionId,
        expectedPublicationId: null,
        occurrenceIds: legacyPlacements.map((item) => item.occurrenceId),
      },
      200,
    );
    const publicationId = released.revisionId as string;
    const selectedId = fixture.newOccurrenceId();
    const privateDraft = [
      ...legacyPlacements,
      {
        occurrenceId: selectedId,
        parentId: null,
        position: legacyPlacements.length,
        title: 'First selected chapter',
        kind: 'chapter',
        target: selectedTarget,
      },
    ];
    const revised = await fixture.native.command(`${bookPath}:revise`, {
      expectedRevisionId: created.revisionId,
      placements: privateDraft,
    });
    let expectedRevisionId = revised.revisionId as string;

    const oldReadPath = `${bookPath}/occurrences/${oldChapterId}?kind=publication&revisionId=${publicationId}`;
    const retainedBefore = await fixture.native.call('GET', oldReadPath, undefined, { anonymous: true });
    expect(retainedBefore.status).toBe(200);
    expect(retainedBefore.value.occurrence).toMatchObject({
      occurrenceId: oldChapterId,
      availability: 'available',
      kind: 'chapter',
      target: legacyTarget,
    });

    const advancePath = `${bookPath}:advanceLegacyPublicBaseline`;
    const advance = (body: Record<string, unknown>, key = crypto.randomUUID()) =>
      fixture.native.call('POST', advancePath, body, { key });
    const common = { expectedRevisionId, expectedPublicationId: publicationId };
    const startInput = { ...common, step: 'startBuild' };
    const started = await advance(startInput);
    expect(started.status).toBe(200);
    expect(started.value).toMatchObject({
      catalogueId: fixture.catalogueId,
      sourcePublicationId: publicationId,
      expectedPlacementCount: 21,
      nextStep: 'build',
      buildFrontier: { afterOrdinal: -1 },
    });

    const firstPageInput = { ...common, step: 'build', frontier: { afterOrdinal: -1 } };
    const firstPageKey = crypto.randomUUID();
    const firstPage = await advance(firstPageInput, firstPageKey);
    expect(firstPage.status).toBe(200);
    expect(firstPage.value).toMatchObject({ nextStep: 'build', buildFrontier: { afterOrdinal: 19 } });
    const firstPageReplay = await advance(firstPageInput, firstPageKey);
    expect(firstPageReplay.status).toBe(200);
    expect(firstPageReplay.value).toEqual(firstPage.value);

    const builderRows = async () =>
      fixture.native.pool.query<{
        input_id: string;
        after_ordinal: string;
        pages: string;
      }>(
        `SELECT s.input_id,b.after_ordinal::text,
                (SELECT count(*)::text FROM content.hosted_version_builder_page p
                 WHERE p.route=s.route AND p.catalogue_id=s.catalogue_id AND p.input_id=s.input_id) AS pages
         FROM content.hosted_version_builder_source s
         JOIN content.hosted_version_builder b
           ON b.route=s.route AND b.catalogue_id=s.catalogue_id AND b.input_id=s.input_id
         WHERE s.route=$1 AND s.catalogue_id=$2 AND s.source_kind='public' AND s.publication_id=$3`,
        [routeOf(fixture.catalogueId), fixture.catalogueId, publicationId],
      );
    const afterReplay = await builderRows();
    expect(afterReplay.rows).toHaveLength(1);
    expect(afterReplay.rows[0]).toMatchObject({ after_ordinal: '19', pages: '1' });

    const staleDraft = await fixture.native.command(`${bookPath}:revise`, {
      expectedRevisionId,
      placements: [
        ...privateDraft,
        {
          occurrenceId: fixture.newOccurrenceId(),
          parentId: null,
          position: privateDraft.length,
          title: 'Draft only while preparation runs',
          kind: 'part',
        },
      ],
    });
    const authorizedReplayAfterDraftChange = await advance(firstPageInput, firstPageKey);
    expect(authorizedReplayAfterDraftChange.status).toBe(200);
    expect(authorizedReplayAfterDraftChange.value).toEqual(firstPage.value);
    const staleRequest = await advance({
      ...common,
      step: 'build',
      frontier: { afterOrdinal: 19 },
    });
    expect(staleRequest.status).toBe(412);
    expect((await builderRows()).rows[0]).toMatchObject({ after_ordinal: '19', pages: '1' });
    expectedRevisionId = staleDraft.revisionId as string;

    const finalPage = await advance({
      expectedRevisionId,
      expectedPublicationId: publicationId,
      step: 'build',
      frontier: { afterOrdinal: 19 },
    });
    expect(finalPage.status).toBe(200);
    expect(finalPage.value).toMatchObject({
      nextStep: 'seal',
      buildFrontier: { afterOrdinal: 20 },
      sealFromFrontier: { afterOrdinal: 19 },
    });
    const sealFrontier = finalPage.value.sealFromFrontier;
    const sealed = await advance({
      expectedRevisionId,
      expectedPublicationId: publicationId,
      step: 'seal',
      frontier: sealFrontier,
    });
    expect(sealed.status).toBe(200);
    expect(sealed.value.nextStep).toBe('receive');
    expect((await fixture.native.call('GET', oldReadPath, undefined, { anonymous: true })).value.occurrence).toEqual(
      retainedBefore.value.occurrence,
    );

    let progress = await advance({
      expectedRevisionId,
      expectedPublicationId: publicationId,
      step: 'receive',
      frontier: sealFrontier,
    });
    expect(progress.status).toBe(200);
    expect(progress.value.nextStep).toBe('apply');
    while (progress.value.nextStep === 'apply') {
      progress = await advance({
        expectedRevisionId,
        expectedPublicationId: publicationId,
        step: 'apply',
        cursor: progress.value.receivingCursor,
      });
      expect(progress.status).toBe(200);
      expect(
        (
          await fixture.native.pool.query<{ publication_id: string }>(
            `SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
            [routeOf(fixture.catalogueId), fixture.catalogueId],
          )
        ).rows[0]?.publication_id,
      ).toBe(publicationId);
    }
    expect(progress.value.nextStep).toBe('complete');
    const complete = await advance({
      expectedRevisionId,
      expectedPublicationId: publicationId,
      step: 'complete',
    });
    expect(complete.status).toBe(200);
    expect(complete.value.nextStep).toBe('done');

    const published = await fixture.native.call(
      'POST',
      `${bookPath}:publishChapter`,
      {
        expectedRevisionId,
        expectedPublicationId: publicationId,
        occurrenceId: selectedId,
        target: selectedTarget,
        parentId: null,
        beforeOccurrenceId: null,
        selectedAncestors: [],
      },
      { key: crypto.randomUUID() },
    );
    expect(published.status).toBe(200);
    const newPublicationId = published.value.revisionId as string;
    const selectedRead = await fixture.native.call(
      'GET',
      `${bookPath}/occurrences/${selectedId}?kind=publication&revisionId=${newPublicationId}`,
      undefined,
      { anonymous: true },
    );
    expect(selectedRead.status).toBe(200);
    expect(selectedRead.value.occurrence).toMatchObject({
      occurrenceId: selectedId,
      availability: 'available',
      kind: 'chapter',
      target: selectedTarget,
    });
    const retainedAfter = await fixture.native.call('GET', oldReadPath, undefined, { anonymous: true });
    expect(retainedAfter.status).toBe(200);
    expect(retainedAfter.value.occurrence).toEqual(retainedBefore.value.occurrence);
    expect(retainedAfter.value.document).toEqual(retainedBefore.value.document);
  } finally {
    await fixture.close();
  }
});
