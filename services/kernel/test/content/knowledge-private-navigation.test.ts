import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { routeOf } from '../../src/route/route.ts';
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

function withCursor(path: string, cursor: string) {
  return `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
}

test('owners reload paged notebooks and current outlines, then review publication CAS from the private read', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Reloadable knowledge navigation' },
  });
  const accountId = fixture.author.actor.accountId;
  const notebook = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Research notes',
  });
  const secondNotebook = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Reference notes',
  });

  const documents: Record<string, string>[] = [];
  let structureRevisionId = notebook.structureRevisionId as string;
  for (let index = 0; index < 52; index++) {
    const created = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
      ...documentInput(`Outline ${String(index + 1).padStart(2, '0')}`),
      expectedStructureRevisionId: structureRevisionId,
      parentPlacementId: null,
    });
    documents.push(created);
    structureRevisionId = created.structureRevisionId as string;
  }

  const inventoryPath = `/v1/accounts/${accountId}/knowledge/notebooks?limit=1`;
  const firstInventory = await fixture.call('GET', inventoryPath);
  expect(firstInventory.status).toBe(200);
  expect(firstInventory.value.notebooks).toHaveLength(1);
  expect(firstInventory.value.next).toEqual(expect.any(String));
  const secondInventory = await fixture.call('GET', withCursor(inventoryPath, firstInventory.value.next));
  expect(secondInventory.status).toBe(200);
  expect(secondInventory.value.notebooks).toHaveLength(1);
  expect(secondInventory.value.next).toBeNull();
  const inventoried = [...firstInventory.value.notebooks, ...secondInventory.value.notebooks];
  expect(inventoried.map(({ notebookId }: { notebookId: string }) => notebookId).sort()).toEqual(
    [notebook.notebookId, secondNotebook.notebookId].sort(),
  );
  const expectedInventoryOrder = [...inventoried].sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.notebookId.localeCompare(right.notebookId),
  );
  expect(inventoried.map(({ notebookId }: { notebookId: string }) => notebookId)).toEqual(
    expectedInventoryOrder.map(({ notebookId }: { notebookId: string }) => notebookId),
  );
  expect((await fixture.call('GET', `/v1/accounts/${accountId}/knowledge/notebooks?limit=51`)).status).toBe(400);
  expect(
    (await fixture.call('GET', `/v1/accounts/${accountId}/knowledge/notebooks`, undefined, { other: true })).status,
  ).toBe(404);

  const outlinePath = `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/outline?limit=50`;
  const initialOutline = await fixture.call('GET', outlinePath);
  expect(initialOutline.status).toBe(200);
  expect(initialOutline.value.structureRevisionId).toBe(structureRevisionId);
  expect(initialOutline.value.placements).toHaveLength(50);
  expect(initialOutline.value.next).toEqual(expect.any(String));

  const child = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...documentInput('Nested outline item'),
    expectedStructureRevisionId: structureRevisionId,
    parentPlacementId: documents[0]!.placementId,
  });
  const staleOutline = await fixture.call('GET', withCursor(outlinePath, initialOutline.value.next));
  expect(staleOutline.status).toBe(409);
  expect(staleOutline.value.code).toBe('stale_cursor');

  const currentFirstOutline = await fixture.call('GET', outlinePath);
  expect(currentFirstOutline.value.structureRevisionId).toBe(child.structureRevisionId);
  expect(currentFirstOutline.value.placements).toHaveLength(50);
  const currentSecondOutline = await fixture.call('GET', withCursor(outlinePath, currentFirstOutline.value.next));
  expect(currentSecondOutline.status).toBe(200);
  expect(currentSecondOutline.value.structureRevisionId).toBe(child.structureRevisionId);
  expect(currentSecondOutline.value.placements).toHaveLength(2);
  expect(currentSecondOutline.value.next).toBeNull();
  const outline = [...currentFirstOutline.value.placements, ...currentSecondOutline.value.placements];
  expect(outline.map(({ documentId }: { documentId: string }) => documentId)).toEqual(
    documents.map(({ documentId }) => documentId!),
  );
  expect(
    outline.every(({ parentPlacementId }: { parentPlacementId: string | null }) => parentPlacementId === null),
  ).toBe(true);
  const positions = outline.map(({ position }: { position: string }) => BigInt(position));
  expect(positions.every((position, index) => index === 0 || positions[index - 1]! < position)).toBe(true);

  const nestedOutline = await fixture.call(
    'GET',
    `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/outline?parentPlacementId=${documents[0]!.placementId}`,
  );
  expect(nestedOutline.status).toBe(200);
  expect(nestedOutline.value.parentPlacementId).toBe(documents[0]!.placementId);
  expect(nestedOutline.value.placements).toMatchObject([
    { placementId: child.placementId, documentId: child.documentId, parentPlacementId: documents[0]!.placementId },
  ]);

  const selected = documents[0]!;
  const privatePath = `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/documents/${selected.documentId}`;
  const initialRead = await fixture.call('GET', privatePath);
  expect(initialRead.status).toBe(200);
  expect(initialRead.value.document.publicationId).toBeNull();
  const firstSelection = await fixture.command(
    `/v1/knowledge/documents/${selected.documentId}/publication:select`,
    {
      expectedHeadRevisionId: initialRead.value.document.revisionId,
      expectedPublicationId: initialRead.value.document.publicationId,
      revisionId: initialRead.value.document.revisionId,
    },
    200,
  );
  const selectedRead = await fixture.call('GET', privatePath);
  expect(selectedRead.value.document.publicationId).toBe(firstSelection.publicationId);
  const firstPublicRead = await fixture.call('GET', `/v1/knowledge/documents/${selected.documentId}`, undefined, {
    anonymous: true,
  });
  expect(firstPublicRead.status).toBe(200);
  expect(firstPublicRead.value.document.revisionId).toBe(selected.revisionId);

  const revised = await fixture.command(
    `/v1/knowledge/documents/${selected.documentId}/revisions:revise`,
    { ...documentInput('Replacement publication'), expectedHeadRevisionId: selectedRead.value.document.revisionId },
    200,
  );
  const draftRead = await fixture.call('GET', privatePath);
  expect(draftRead.value.document.revisionId).toBe(revised.revisionId);
  expect(draftRead.value.document.publicationId).toBe(firstSelection.publicationId);
  const replacement = await fixture.command(
    `/v1/knowledge/documents/${selected.documentId}/publication:select`,
    {
      expectedHeadRevisionId: draftRead.value.document.revisionId,
      expectedPublicationId: draftRead.value.document.publicationId,
      revisionId: draftRead.value.document.revisionId,
    },
    200,
  );
  const replacementRead = await fixture.call('GET', privatePath);
  expect(replacementRead.value.document.publicationId).toBe(replacement.publicationId);
  expect(replacementRead.value.document.publicationId).not.toBe(firstSelection.publicationId);
  const withdrawal = await fixture.command(
    `/v1/knowledge/documents/${selected.documentId}/publication:select`,
    {
      expectedHeadRevisionId: replacementRead.value.document.revisionId,
      expectedPublicationId: replacementRead.value.document.publicationId,
      revisionId: null,
    },
    200,
  );
  expect(withdrawal.publicationId).toBeNull();
  expect((await fixture.call('GET', privatePath)).value.document.publicationId).toBeNull();
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${selected.documentId}`, undefined, { anonymous: true }))
      .status,
  ).toBe(404);

  const sibling = documents[1]!;
  const siblingPath = `/v1/accounts/${accountId}/knowledge/notebooks/${notebook.notebookId}/documents/${sibling.documentId}`;
  expect((await fixture.call('GET', siblingPath)).value.document.publicationId).toBeNull();
  expect((await fixture.call('GET', siblingPath, undefined, { other: true })).status).toBe(404);
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${sibling.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);

  const accountRoute = routeOf(accountId)!;
  await fixture.pool.query(
    'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
    [accountRoute, accountId],
  );
  try {
    const revoked = await fixture.call('GET', privatePath);
    expect(revoked.status).toBe(401);
    expect(revoked.value.code).toBe('invalid_credentials');
  } finally {
    await fixture.pool.query(
      'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch-1 WHERE route=$1 AND account_id=$2',
      [accountRoute, accountId],
    );
  }
});
