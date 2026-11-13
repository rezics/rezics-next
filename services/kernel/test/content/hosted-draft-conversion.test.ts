import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

async function legacyBook() {
  const book = await f.native.thread();
  const source = await f.native.thread();
  const partId = f.newOccurrenceIdFor(book.firstPost.id);
  const chapterId = f.newOccurrenceIdFor(book.firstPost.id);
  const target = f.target(source);
  const placements = [
    { occurrenceId: partId, parentId: null, position: 0, title: 'Original part', kind: 'part' as const },
    {
      occurrenceId: chapterId,
      parentId: partId,
      position: 0,
      title: 'Private chapter title',
      kind: 'chapter' as const,
      target,
    },
  ];
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: book.firstPost.id,
    threadId: book.id,
    placements,
  });
  expect(created.status).toBe(201);
  return {
    catalogueId: book.firstPost.id,
    path: `/v1/hostedCatalogues/${book.firstPost.id}`,
    partId,
    chapterId,
    target,
    placements,
    revisionId: created.value.revisionId as string,
  };
}

function send(path: string, body: unknown, key: string, bearer: string | null = f.native.author.bearer) {
  return f.native.system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method: 'POST',
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function step(path: string, body: unknown, key = crypto.randomUUID()) {
  const response = await send(path, body, key);
  return { response, value: await response.json() };
}

async function createPublicRelease(path: string, catalogueId: string, revisionId: string, occurrenceIds: string[]) {
  const published = await f.native.call('POST', `${path}:publish`, {
    expectedRevisionId: revisionId,
    expectedPublicationId: null,
    occurrenceIds,
  });
  expect(published.status).toBe(200);
  const page = await f.native.call('GET', `${path}/children?kind=publication`);
  expect(page.status).toBe(200);
  expect(page.value.catalogueId).toBe(catalogueId);
  return page.value;
}

async function reachActivationCommit(path: string, expectedRevisionId: string, inputId: string) {
  let result = await step(path + ':convertDraft', {
    step: 'seal',
    inputId,
    expectedRevisionId,
  });
  expect(result.response.status).toBe(200);
  result = await step(path + ':convertDraft', {
    step: 'materialize',
    inputId,
    expectedRevisionId,
  });
  expect(result.response.status).toBe(200);
  for (let index = 0; result.value.nextStep === 'materializePage' && index < 12; index += 1) {
    result = await step(path + ':convertDraft', {
      step: 'materializePage',
      inputId,
      expectedRevisionId,
    });
    expect(result.response.status).toBe(200);
  }
  expect(result.value.nextStep).toBe('commit');
}

test('mounted conversion resumes a nested Book, replays a lost page response, and enables its first ordered edit', async () => {
  const book = await legacyBook();
  const conversionPath = `${book.path}:convertDraft`;
  const releaseBefore = await createPublicRelease(book.path, book.catalogueId, book.revisionId, [
    book.partId,
    book.chapterId,
  ]);
  const originalLink = await f.native.call(
    'GET',
    `${book.path}/occurrences/${book.chapterId}?kind=structure&revisionId=${book.revisionId}`,
  );
  expect(originalLink.status).toBe(200);

  const captureBody = { step: 'capture', expectedRevisionId: book.revisionId };
  expect(
    (await send(conversionPath, captureBody, crypto.randomUUID(), f.native.system.actors.other.bearer)).status,
  ).toBe(403);
  expect((await send(conversionPath, captureBody, crypto.randomUUID(), null)).status).toBe(401);

  const capture = await step(conversionPath, captureBody);
  expect(capture.response.status).toBe(200);
  expect(capture.value).toMatchObject({
    catalogueId: book.catalogueId,
    phase: 'captured',
    nextStep: 'begin',
    coverage: { visited: '0', expected: '2', complete: false },
  });
  const inputId = capture.value.inputId as string;

  const begin = await step(conversionPath, {
    step: 'begin',
    inputId,
    expectedRevisionId: book.revisionId,
  });
  expect(begin.response.status).toBe(200);
  expect(begin.value).toMatchObject({ phase: 'building', nextStep: 'page' });

  const pageBody = {
    step: 'page',
    inputId,
    expectedRevisionId: book.revisionId,
    cursor: begin.value.frontier,
  };
  const pageKey = crypto.randomUUID();
  const lostResponse = await step(conversionPath, pageBody, pageKey);
  expect(lostResponse.response.status).toBe(200);
  expect(lostResponse.value).toMatchObject({
    phase: 'building',
    nextStep: 'seal',
    coverage: { visited: '2', expected: '2', complete: true },
  });
  expect(JSON.stringify(lostResponse.value)).not.toContain('Private chapter title');
  expect(JSON.stringify(lostResponse.value)).not.toContain(book.target.postId);
  const replay = await step(conversionPath, pageBody, pageKey);
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual(lostResponse.value);

  await reachActivationCommit(book.path, book.revisionId, inputId);
  const committed = await step(conversionPath, {
    step: 'commit',
    inputId,
    expectedRevisionId: book.revisionId,
  });
  expect(committed.response.status).toBe(200);
  expect(committed.value).toMatchObject({ phase: 'complete', nextStep: 'complete' });
  const convertedRevisionId = committed.value.revisionId as string;
  expect(convertedRevisionId).not.toBe(book.revisionId);

  const oldLinkAfterConversion = await f.native.call(
    'GET',
    `${book.path}/occurrences/${book.chapterId}?kind=structure&revisionId=${book.revisionId}`,
  );
  expect(oldLinkAfterConversion.status).toBe(200);
  expect(oldLinkAfterConversion.value).toEqual(originalLink.value);

  const insertedId = f.newOccurrenceIdFor(book.catalogueId);
  const inserted = await f.native.call('POST', `${book.path}:insertDraftPoint`, {
    expectedRevisionId: convertedRevisionId,
    occurrenceId: insertedId,
    parentId: book.partId,
    beforeOccurrenceId: book.chapterId,
    title: 'First ordered child',
    placement: { kind: 'part' },
  });
  expect(inserted.status).toBe(200);
  const current = await f.native.call('GET', `${book.path}/children?kind=structure&parentId=${book.partId}`);
  expect(current.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    insertedId,
    book.chapterId,
  ]);
  const oldRelease = await f.native.call('GET', `${book.path}/children?kind=publication`);
  expect(oldRelease.value).toEqual(releaseBefore);
});

test('stale activation preserves the competing draft head and public release', async () => {
  const book = await legacyBook();
  const releaseBefore = await createPublicRelease(book.path, book.catalogueId, book.revisionId, [
    book.partId,
    book.chapterId,
  ]);
  const capture = await step(`${book.path}:convertDraft`, {
    step: 'capture',
    expectedRevisionId: book.revisionId,
  });
  expect(capture.response.status).toBe(200);
  const inputId = capture.value.inputId as string;
  const begin = await step(`${book.path}:convertDraft`, {
    step: 'begin',
    inputId,
    expectedRevisionId: book.revisionId,
  });
  expect(begin.response.status).toBe(200);
  const page = await step(`${book.path}:convertDraft`, {
    step: 'page',
    inputId,
    expectedRevisionId: book.revisionId,
    cursor: begin.value.frontier,
  });
  expect(page.response.status).toBe(200);
  expect(page.value.nextStep).toBe('seal');
  await reachActivationCommit(book.path, book.revisionId, inputId);

  const replacementPlacements = book.placements.map((placement) =>
    placement.occurrenceId === book.partId ? { ...placement, title: 'Racing draft edit' } : placement,
  );
  const raced = await f.native.call('POST', `${book.path}:revise`, {
    expectedRevisionId: book.revisionId,
    placements: replacementPlacements,
  });
  expect(raced.status).toBe(200);
  expect(raced.value.revisionId).not.toBe(book.revisionId);

  const staleCommit = await step(`${book.path}:convertDraft`, {
    step: 'commit',
    inputId,
    expectedRevisionId: book.revisionId,
  });
  expect(staleCommit.response.status).toBe(412);

  const current = await f.native.call('GET', `${book.path}/children?kind=structure`);
  expect(current.value.revisionId).toBe(raced.value.revisionId);
  expect(current.value.items[0]).toMatchObject({ title: 'Racing draft edit' });
  const publicAfter = await f.native.call('GET', `${book.path}/children?kind=publication`);
  expect(publicAfter.value).toEqual(releaseBefore);
});
