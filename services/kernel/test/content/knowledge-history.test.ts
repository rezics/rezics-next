import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof postPublicationFixture>>;

beforeAll(async () => {
  fixture = await postPublicationFixture();
});

afterAll(async () => {
  await fixture?.close();
});

function documentInput(title: string) {
  return { title, body: fromPlainText(title), licence: 'MIT', subjectIds: [] };
}

test('owners move and reorder stable placements, reload exact structure and body history, and keep publication selection', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Knowledge history' },
  });
  const accountId = fixture.author.actor.accountId;
  const notebook = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Knowledge history',
  });
  let structureRevisionId = notebook.structureRevisionId as string;
  const create = async (title: string, parentPlacementId: string | null) => {
    const value = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
      ...documentInput(title),
      expectedStructureRevisionId: structureRevisionId,
      parentPlacementId,
    });
    structureRevisionId = value.structureRevisionId as string;
    return value;
  };
  const section = await create('Section', null);
  const second = await create('Second', null);
  const third = await create('Third', null);
  const note = await create('Note v1', section.placementId);
  const originalStructureRevisionId = structureRevisionId;
  const accountDocumentPath = `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/documents/${note.documentId}`;
  const initialRead = await fixture.call('GET', accountDocumentPath);
  const publication = await fixture.command(
    `/v1/knowledge/documents/${note.documentId}/publication:select`,
    {
      expectedHeadRevisionId: initialRead.value.document.revisionId,
      expectedPublicationId: initialRead.value.document.publicationId,
      revisionId: initialRead.value.document.revisionId,
    },
    200,
  );
  const revised = await fixture.command(
    `/v1/knowledge/documents/${note.documentId}/revisions:revise`,
    { ...documentInput('Note v2'), expectedHeadRevisionId: initialRead.value.document.revisionId },
    200,
  );

  const movePath = `/v1/knowledge/notebooks/${notebook.notebookId}/placements/${second.placementId}:move`;
  const moveBody = {
    expectedStructureRevisionId,
    destinationParentPlacementId: section.placementId,
    beforePlacementId: note.placementId,
  };
  const moved = await fixture.command(movePath, moveBody, 200, 'POST');
  structureRevisionId = moved.structureRevisionId as string;
  const reorderPath = `/v1/knowledge/notebooks/${notebook.notebookId}/placements/${third.placementId}:move`;
  const reorderBody = {
    expectedStructureRevisionId: structureRevisionId,
    destinationParentPlacementId: null,
    beforePlacementId: section.placementId,
  };
  const reordered = await fixture.call('POST', reorderPath, reorderBody, { key: 'knowledge-history-reorder-replay' });
  expect(reordered.status).toBe(200);
  structureRevisionId = reordered.value.structureRevisionId;
  expect(
    (await fixture.call('POST', reorderPath, reorderBody, { key: 'knowledge-history-reorder-replay' })).value,
  ).toEqual(reordered.value);

  const rootPath = `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/outline`;
  const original = await fixture.call('GET', `${rootPath}?revisionId=${originalStructureRevisionId}`);
  const afterMove = await fixture.call(
    'GET',
    `${rootPath}?revisionId=${moved.structureRevisionId}&parentPlacementId=${section.placementId}`,
  );
  const current = await fixture.call('GET', rootPath);
  expect(original.value.placements.map(({ placementId }: { placementId: string }) => placementId)).toEqual([
    section.placementId,
    second.placementId,
    third.placementId,
  ]);
  expect(afterMove.value.placements.map(({ placementId }: { placementId: string }) => placementId)).toEqual([
    second.placementId,
    note.placementId,
  ]);
  expect(current.value.placements.map(({ placementId }: { placementId: string }) => placementId)).toEqual([
    third.placementId,
    section.placementId,
  ]);
  const historical = await fixture.call(
    'GET',
    `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/history?limit=50`,
  );
  expect(historical.status).toBe(200);
  expect(
    historical.value.revisions.some(
      (revision: { structureRevisionId: string }) => revision.structureRevisionId === originalStructureRevisionId,
    ),
  ).toBe(true);
  expect(
    historical.value.revisions.flatMap((revision: { changes: { action: string }[] }) =>
      revision.changes.map(({ action }) => action),
    ),
  ).toContain('placement_moved');
  expect(
    historical.value.revisions.flatMap((revision: { changes: { action: string }[] }) =>
      revision.changes.map(({ action }) => action),
    ),
  ).toContain('placement_reordered');
  expect(
    (
      await fixture.call(
        'GET',
        `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/history`,
        undefined,
        { other: true },
      )
    ).status,
  ).toBe(404);

  const history = await fixture.call('GET', `${accountDocumentPath}/history?limit=50`);
  expect(history.value.revisions.map(({ revisionId }: { revisionId: string }) => revisionId)).toEqual([
    revised.revisionId,
    initialRead.value.document.revisionId,
  ]);
  const compared = await fixture.call(
    'GET',
    `${accountDocumentPath}/compare?leftRevisionId=${initialRead.value.document.revisionId}&rightRevisionId=${revised.revisionId}`,
  );
  expect(compared.status).toBe(200);
  expect(compared.value.left.canonicalBytes).toBe(initialRead.value.document.canonicalBytes);
  expect(compared.value.right.canonicalBytes).toBe(
    (await fixture.call('GET', accountDocumentPath)).value.document.canonicalBytes,
  );
  const currentPrivate = await fixture.call('GET', accountDocumentPath);
  expect(currentPrivate.value.document.publicationId).toBe(publication.publicationId);
  const publicRead = await fixture.call('GET', `/v1/knowledge/documents/${note.documentId}`, undefined, {
    anonymous: true,
  });
  expect(publicRead.value.document.revisionId).toBe(initialRead.value.document.revisionId);
  expect(publicRead.value.document.publicationId).toBe(publication.publicationId);

  const staleMove = await fixture.call(
    'POST',
    reorderPath,
    {
      expectedStructureRevisionId: originalStructureRevisionId,
      destinationParentPlacementId: null,
      beforePlacementId: section.placementId,
    },
    { key: 'knowledge-history-stale-move' },
  );
  expect(staleMove.status).toBe(412);
  const cycle = await fixture.call(
    'POST',
    `/v1/knowledge/notebooks/${notebook.notebookId}/placements/${section.placementId}:move`,
    {
      expectedStructureRevisionId: structureRevisionId,
      destinationParentPlacementId: note.placementId,
      beforePlacementId: null,
    },
  );
  expect(cycle.status).toBe(400);
});
