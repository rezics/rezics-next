import { expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

test('mounted draft updates preserve occurrence identity, history, counts, and public selection', async () => {
  const f = await hostedChaptersFixture();
  try {
    const catalogue = await f.native.thread();
    const catalogueId = catalogue.firstPost.id;
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    const updatePath = `${path}:updateDraftPoint`;
    const created = await f.native.call('POST', '/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId: catalogue.id,
      placements: [],
    });
    expect(created.status).toBe(201);

    const parentId = f.newOccurrenceIdFor(catalogueId);
    const nestedId = f.newOccurrenceIdFor(catalogueId);
    const chapterId = f.newOccurrenceIdFor(catalogueId);
    const nextChapterId = f.newOccurrenceIdFor(catalogueId);
    const siblingId = f.newOccurrenceIdFor(catalogueId);
    const source = await f.native.thread();
    const originalTarget = f.target(source);
    let head = created.value.revisionId;
    const insert = async (
      occurrenceId: string,
      parentId: string | null,
      title: string,
      placement: { kind: 'part' } | { kind: 'chapter'; target: typeof originalTarget },
    ) => {
      const result = await f.native.call('POST', `${path}:insertDraftPoint`, {
        expectedRevisionId: head,
        occurrenceId,
        parentId,
        beforeOccurrenceId: null,
        title,
        placement,
      });
      expect(result.status, JSON.stringify(result.value)).toBe(200);
      head = result.value.revisionId;
      return result.value;
    };
    await insert(parentId, null, 'Parent', { kind: 'part' });
    await insert(siblingId, null, 'Sibling', { kind: 'part' });
    await insert(nestedId, parentId, 'Nested part', { kind: 'part' });
    await insert(chapterId, nestedId, 'Original chapter', { kind: 'chapter', target: originalTarget });
    await insert(nextChapterId, parentId, 'Next chapter', { kind: 'chapter', target: originalTarget });
    const originalRevisionId = head;

    const publication = await f.native.call('POST', `${path}:publish`, {
      expectedRevisionId: head,
      expectedPublicationId: null,
      occurrenceIds: [parentId, nestedId, chapterId, nextChapterId, siblingId],
    });
    expect(publication.status, JSON.stringify(publication.value)).toBe(200);
    const readCounts = async (revisionId: string) => {
      const result = await f.native.pool.query<{ placement_count: string; chapter_count: string }>(
        `SELECT snapshot.placement_count::text AS placement_count,snapshot.chapter_count::text AS chapter_count
         FROM content.hosted_version_revision descriptor
         JOIN content.hosted_tree_snapshot_version snapshot
           USING (route,catalogue_id,generation_id,sequence)
         WHERE descriptor.route=$1 AND descriptor.catalogue_id=$2 AND descriptor.revision_id=$3`,
        [routeOf(catalogueId), catalogueId, revisionId],
      );
      return result.rows[0];
    };

    const renameInput = {
      expectedRevisionId: head,
      occurrenceId: nestedId,
      title: 'Renamed nested part',
      target: null,
    };
    const malformed = await f.native.call('POST', updatePath, { ...renameInput, extra: true });
    expect(malformed.status).toBe(400);
    expect((await f.native.call('POST', updatePath, renameInput, { other: true })).status).toBe(403);
    expect((await f.native.call('POST', updatePath, renameInput, { anonymous: true })).status).toBe(401);

    const renamed = await f.native.call('POST', updatePath, renameInput);
    expect(renamed.status, JSON.stringify(renamed.value)).toBe(200);
    head = renamed.value.revisionId;
    const renamedPage = await f.native.call('GET', `${path}/children?kind=structure&parentId=${parentId}`);
    expect(renamedPage.value.items).toEqual([
      expect.objectContaining({ occurrenceId: nestedId, kind: 'part', title: 'Renamed nested part' }),
    ]);

    const revisedSource = await f.native.revise(source.firstPost, {});
    expect(revisedSource.status).toBe(200);
    const revisedTarget = {
      ...originalTarget,
      revisionId: revisedSource.value.post.revisionId,
      sha256: revisedSource.value.post.sha256,
    };
    const chapterInput = {
      expectedRevisionId: head,
      occurrenceId: chapterId,
      title: 'Revised chapter title',
      target: revisedTarget,
    };
    const firstKey = crypto.randomUUID();
    const updated = await f.native.call('POST', updatePath, chapterInput, { key: firstKey });
    expect(updated.status, JSON.stringify(updated.value)).toBe(200);
    head = updated.value.revisionId;

    expect(await readCounts(originalRevisionId)).toMatchObject({ placement_count: '5', chapter_count: '2' });
    expect(await readCounts(head)).toMatchObject({ placement_count: '5', chapter_count: '2' });
    const currentRoots = await f.native.call('GET', `${path}/children?kind=structure`);
    expect(currentRoots.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      parentId,
      siblingId,
    ]);
    const currentChapter = await f.native.call('GET', `${path}/occurrences/${chapterId}?kind=structure`);
    expect(currentChapter.value.occurrence).toMatchObject({
      occurrenceId: chapterId,
      parentId: nestedId,
      kind: 'chapter',
      title: 'Revised chapter title',
      target: revisedTarget,
    });
    expect(currentChapter.value.document.sha256).toBe(revisedTarget.sha256);
    const chapterIndexPage = await f.native.call(
      'GET',
      `${path}/occurrences/${nextChapterId}/navigation?kind=structure&direction=previous`,
    );
    expect(chapterIndexPage.value.items).toEqual([
      expect.objectContaining({
        occurrenceId: chapterId,
        title: 'Revised chapter title',
        target: revisedTarget,
      }),
    ]);

    const oldChapter = await f.native.call(
      'GET',
      `${path}/occurrences/${chapterId}?kind=structure&revisionId=${originalRevisionId}`,
    );
    const oldNestedPart = await f.native.call(
      'GET',
      `${path}/children?kind=structure&parentId=${parentId}&revisionId=${originalRevisionId}`,
    );
    expect(oldNestedPart.value.items).toEqual([
      expect.objectContaining({ occurrenceId: nestedId, title: 'Nested part' }),
    ]);
    expect(oldChapter.value.occurrence).toMatchObject({
      occurrenceId: chapterId,
      parentId: nestedId,
      kind: 'chapter',
      title: 'Original chapter',
      target: originalTarget,
    });
    expect(oldChapter.value.document.sha256).toBe(originalTarget.sha256);
    const publishedRoots = await f.native.call('GET', `${path}/children`);
    const publishedChapter = await f.native.call('GET', `${path}/occurrences/${chapterId}`);
    expect(publishedRoots.value.revisionId).toBe(publication.value.revisionId);
    expect(publishedChapter.value.occurrence).toMatchObject({ title: 'Original chapter', target: originalTarget });
    expect(publishedChapter.value.document.sha256).toBe(originalTarget.sha256);

    const laterInput = { ...chapterInput, expectedRevisionId: head, title: 'Later title' };
    const later = await f.native.call('POST', updatePath, laterInput);
    expect(later.status).toBe(200);
    const replay = await f.native.call('POST', updatePath, chapterInput, { key: firstKey });
    expect(replay.value).toEqual(updated.value);
    const stillLater = await f.native.call('GET', `${path}/occurrences/${chapterId}?kind=structure`);
    expect(stillLater.value.occurrence.title).toBe('Later title');

    const stale = await f.native.call('POST', updatePath, {
      ...renameInput,
      expectedRevisionId: head,
      title: 'Stale rename',
    });
    expect(stale.status).toBe(412);
    const afterStale = await f.native.call('GET', `${path}/children?kind=structure&parentId=${parentId}`);
    expect(afterStale.value.revisionId).toBe(later.value.revisionId);
    expect(afterStale.value.items).toEqual([
      expect.objectContaining({ occurrenceId: nestedId, title: 'Renamed nested part' }),
    ]);
    expect(await readCounts(later.value.revisionId)).toMatchObject({ placement_count: '5', chapter_count: '2' });
  } finally {
    await f.close();
  }
});
