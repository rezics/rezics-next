import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('publishes an ordered frozen catalogue while preserving Post disclosure and stable occurrence links', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const partId = f.newOccurrenceId();
  const emptyPartId = f.newOccurrenceId();
  const firstId = f.newOccurrenceId();
  const duplicateId = f.newOccurrenceId();
  const secondId = f.newOccurrenceId();
  const protectedId = f.newOccurrenceId();
  const draftId = f.newOccurrenceId();
  const firstThread = await f.native.thread();
  const secondThread = await f.native.thread();
  const draftThread = await f.native.thread('draft');
  const first = f.target(firstThread);
  const second = f.target(secondThread);
  const draft = f.target(draftThread);
  const protectedTarget = await f.protectedChapter();
  const placements = [
    { occurrenceId: partId, parentId: null, position: 0, title: 'Part One', kind: 'part' },
    { occurrenceId: firstId, parentId: partId, position: 0, title: 'Chapter One', kind: 'chapter', target: first },
    {
      occurrenceId: duplicateId,
      parentId: partId,
      position: 1,
      title: 'Chapter One, alternate placement',
      kind: 'chapter',
      target: first,
    },
    { occurrenceId: emptyPartId, parentId: null, position: 1, title: 'Empty Part', kind: 'part' },
    { occurrenceId: secondId, parentId: null, position: 2, title: 'Chapter Two', kind: 'chapter', target: second },
    {
      occurrenceId: protectedId,
      parentId: null,
      position: 3,
      title: 'Protected Chapter',
      kind: 'chapter',
      target: protectedTarget,
    },
    { occurrenceId: draftId, parentId: null, position: 4, title: 'Private Draft', kind: 'chapter', target: draft },
  ] as const;
  const createBody = { postId: f.catalogueId, threadId: f.threadId, placements };
  const createKey = crypto.randomUUID();
  const created = await f.native.call('POST', '/v1/hostedCatalogues', createBody, { key: createKey });
  expect(created.status, JSON.stringify(created.value)).toBe(201);
  const createReplay = await f.native.call('POST', '/v1/hostedCatalogues', createBody, { key: createKey });
  expect(createReplay.value).toEqual(created.value);

  const privatePage = await f.native.call('GET', `${path}/children?kind=structure`);
  expect(privatePage.status).toBe(200);
  expect(privatePage.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    partId,
    emptyPartId,
    secondId,
    protectedId,
    draftId,
  ]);
  expect(privatePage.value.items.at(-1)).toMatchObject({
    occurrenceId: draftId,
    availability: 'available',
    target: draft,
  });
  expect((await f.native.call('GET', `${path}/children?kind=structure`, undefined, { anonymous: true })).status).toBe(
    404,
  );

  const selected = [partId, firstId, duplicateId, emptyPartId, secondId, protectedId];
  const publishBody = {
    expectedRevisionId: created.value.revisionId,
    expectedPublicationId: null,
    occurrenceIds: selected,
  };
  const publishKey = crypto.randomUUID();
  const published = await f.native.call('POST', `${path}:publish`, publishBody, { key: publishKey });
  expect(published.status, JSON.stringify(published.value)).toBe(200);
  const publishReplay = await f.native.call('POST', `${path}:publish`, publishBody, { key: publishKey });
  expect(publishReplay.value).toEqual(published.value);

  expect((await f.native.call('GET', `/v1/posts/${draft.postId}`, undefined, { anonymous: true })).status).toBe(404);
  const root = await f.native.call('GET', `${path}/children`, undefined, { anonymous: true });
  expect(root.status).toBe(200);
  expect(root.value).toMatchObject({ kind: 'publication', revisionId: published.value.revisionId });
  expect(root.value.items).toMatchObject([
    { occurrenceId: partId, position: 0, kind: 'part', availability: 'available', title: 'Part One' },
    { occurrenceId: emptyPartId, position: 1, kind: 'part', availability: 'available', title: 'Empty Part' },
    { occurrenceId: secondId, position: 2, kind: 'chapter', availability: 'available', title: 'Chapter Two' },
    { occurrenceId: protectedId, position: 3, kind: 'chapter', availability: 'unavailable' },
  ]);
  expect(root.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).not.toContain(draftId);
  expect(root.value.items[3]).not.toHaveProperty('title');
  expect(root.value.items[3]).not.toHaveProperty('target');

  const childPage = await f.native.call('GET', `${path}/children?parentId=${partId}`, undefined, { anonymous: true });
  expect(childPage.value.items).toMatchObject([
    { occurrenceId: firstId, parentId: partId, position: 0, availability: 'available', target: first },
    { occurrenceId: duplicateId, parentId: partId, position: 1, availability: 'available', target: first },
  ]);
  const emptyChildren = await f.native.call('GET', `${path}/children?parentId=${emptyPartId}`, undefined, {
    anonymous: true,
  });
  expect(emptyChildren.value.items).toEqual([]);

  const originalBytes = Buffer.from(serializeDocument(fromPlainText('Opening')), 'utf8');
  const opened = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(opened.status).toBe(200);
  expect(opened.value.document).toEqual({
    encoding: 'base64',
    canonicalBytes: originalBytes.toString('base64'),
    sha256: createHash('sha256').update(originalBytes).digest('hex'),
    authorId: f.native.author.actor.accountId,
    licence: 'MIT',
  });
  const concealed = await f.native.call(
    'GET',
    `${path}/occurrences/${protectedId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(concealed.value).toMatchObject({
    occurrence: {
      occurrenceId: protectedId,
      parentId: null,
      position: 3,
      kind: 'chapter',
      availability: 'unavailable',
    },
    document: null,
  });
  expect(concealed.value.occurrence).not.toHaveProperty('title');

  const next = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}/navigation?revisionId=${published.value.revisionId}&direction=next`,
    undefined,
    { anonymous: true },
  );
  expect(next.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    duplicateId,
    secondId,
    protectedId,
  ]);
  expect(next.value.items.at(-1)).toMatchObject({ availability: 'unavailable' });
  const previous = await f.native.call(
    'GET',
    `${path}/occurrences/${secondId}/navigation?revisionId=${published.value.revisionId}&direction=previous`,
    undefined,
    { anonymous: true },
  );
  expect(previous.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    duplicateId,
    firstId,
  ]);

  const edited = await f.native.revise(firstThread.firstPost, {});
  expect(edited.status).toBe(200);
  const frozen = await f.native.call(
    'GET',
    `${path}/occurrences/${firstId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(frozen.value.document.canonicalBytes).toBe(originalBytes.toString('base64'));
  expect(frozen.value.document.sha256).toBe(first.sha256);

  const movedPlacements = [
    placements[0],
    { ...placements[2], position: 0 },
    placements[3],
    placements[4],
    placements[5],
    placements[6],
    { ...placements[1], parentId: null, position: 5 },
  ] as const;
  const moveBody = { expectedRevisionId: created.value.revisionId, placements: movedPlacements };
  const moveKey = crypto.randomUUID();
  const moved = await f.native.call('POST', `${path}:revise`, moveBody, { key: moveKey });
  expect(moved.status).toBe(200);
  const laterBody = {
    expectedRevisionId: moved.value.revisionId,
    placements: movedPlacements.map((item: (typeof movedPlacements)[number]) =>
      item.occurrenceId === secondId ? { ...item, title: 'Chapter Two, revised label' } : item,
    ),
  };
  const later = await f.native.call('POST', `${path}:revise`, laterBody, { key: crypto.randomUUID() });
  expect(later.status).toBe(200);
  const moveReplay = await f.native.call('POST', `${path}:revise`, moveBody, { key: moveKey });
  expect(moveReplay.value).toEqual(moved.value);
  const stale = await f.native.call('POST', `${path}:revise`, moveBody, { key: crypto.randomUUID() });
  expect(stale.status).toBe(412);
  const movedPage = await f.native.call('GET', `${path}/children?kind=structure&parentId=${partId}`);
  expect(movedPage.value.items).toMatchObject([{ occurrenceId: duplicateId, position: 0 }]);
  const oldAddress = await f.native.call(
    'GET',
    `${path}/children?revisionId=${published.value.revisionId}&parentId=${partId}`,
    undefined,
    { anonymous: true },
  );
  expect(oldAddress.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    firstId,
    duplicateId,
  ]);

  const concurrentBodies = ['Draft A', 'Draft B'].map((title) => ({
    expectedRevisionId: later.value.revisionId,
    placements: movedPlacements.map((item: (typeof movedPlacements)[number]) =>
      item.occurrenceId === secondId ? { ...item, title } : item,
    ),
  }));
  const concurrent = await Promise.all(
    concurrentBodies.map((body) => f.native.call('POST', `${path}:revise`, body, { key: crypto.randomUUID() })),
  );
  expect(concurrent.filter((result) => result.status === 200)).toHaveLength(1);
  expect(concurrent.filter((result) => result.status === 412)).toHaveLength(1);

  const winner = concurrent.find((result) => result.status === 200)!;
  const badAttachment = movedPlacements.map((item: (typeof movedPlacements)[number]) =>
    item.occurrenceId === firstId ? { ...item, target: { ...first, sha256: '0'.repeat(64) } } : item,
  );
  const rejected = await f.native.call(
    'POST',
    `${path}:revise`,
    {
      expectedRevisionId: winner.value.revisionId,
      placements: badAttachment,
    },
    { key: crypto.randomUUID() },
  );
  expect(rejected.status).toBe(404);
  expect((await f.native.call('GET', `${path}?kind=structure`)).value.revisionId).toBe(winner.value.revisionId);
  expect((await f.native.call('GET', `/v1/posts/${first.postId}`)).status).toBe(200);

  await f.native.command(`/v1/posts/${second.postId}:erase`, { reason: 'Remove chapter source' }, 200);
  const erased = await f.native.call(
    'GET',
    `${path}/occurrences/${secondId}?revisionId=${published.value.revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(erased.value).toMatchObject({
    occurrence: { occurrenceId: secondId, availability: 'unavailable' },
    document: null,
  });
});
