import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { newId, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let observer: ReturnType<typeof observeSql>;
let book: {
  id: string;
  threadId: string;
  postRevisionId: string;
  firstPublicationId: string;
  firstSourceId: string;
  currentPublicationId: string;
  currentSourceId: string;
};

beforeAll(async () => {
  f = await postPublicationFixture();
  const thread = await f.thread('published');
  const titled = await f.revise(thread.firstPost, { title: 'Opening title at publication' });
  expect(titled.status).toBe(200);
  thread.firstPost.revisionId = titled.value.post.revisionId;

  const id = thread.firstPost.id;
  const path = `/v1/hostedCatalogues/${id}`;
  const occurrenceId = newId(routeOf(id)!);
  const created = await f.command('/v1/hostedCatalogues', {
    postId: id,
    threadId: thread.id,
    placements: [{ occurrenceId, parentId: null, position: 0, title: 'Part', kind: 'part' }],
  });
  const first = await f.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [occurrenceId],
    },
    200,
  );
  const revised = await f.command(
    `${path}:revise`,
    {
      expectedRevisionId: created.revisionId,
      placements: [{ occurrenceId, parentId: null, position: 0, title: 'Part revised', kind: 'part' }],
    },
    200,
  );
  const current = await f.command(
    `${path}:publish`,
    {
      expectedRevisionId: revised.revisionId,
      expectedPublicationId: first.revisionId,
      occurrenceIds: [occurrenceId],
    },
    200,
  );
  book = {
    id,
    threadId: thread.id,
    postRevisionId: thread.firstPost.revisionId,
    firstPublicationId: first.revisionId,
    firstSourceId: created.revisionId,
    currentPublicationId: current.revisionId,
    currentSourceId: revised.revisionId,
  };
  observer = observeSql(f.pool);
});

afterAll(async () => {
  await observer?.close();
  await f?.close();
});

async function get(id: string, query = '', bearer?: string) {
  const response = await f.system.kernel.handle(
    new Request(`https://content.test/v1/hostedCatalogues/${id}${query}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
  if (response.status === 200) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
  }
  return { response, status: response.status, value: (await response.json()) as Record<string, any> };
}

function expectMetadataOnly(start: number, count?: number) {
  const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
  if (count === undefined) expect(probes.length).toBeGreaterThan(0);
  else expect(probes).toHaveLength(count);
  expect(probes.every((row) => row.parameters[readChain.params.indexOf('include_body')] === false)).toBe(true);
}

test('point GET opts into the retained current opening title for current and exact historical publications', async () => {
  let start = observer.records.length;
  const baseline = await get(book.id);
  expect(baseline.status).toBe(200);
  expect(baseline.value).toEqual({
    catalogueId: book.id,
    revisionId: book.currentPublicationId,
    kind: 'publication',
    sourceRevisionId: book.currentSourceId,
  });
  expectMetadataOnly(start);

  start = observer.records.length;
  const current = await get(book.id, '?includeTitle=1');
  expect(current.status).toBe(200);
  expect(current.value).toEqual({
    catalogueId: book.id,
    revisionId: book.currentPublicationId,
    kind: 'publication',
    sourceRevisionId: book.currentSourceId,
    title: 'Opening title at publication',
  });
  expectMetadataOnly(start);

  start = observer.records.length;
  const historical = await get(book.id, `?revisionId=${book.firstPublicationId}&kind=publication&includeTitle=1`);
  expect(historical.status).toBe(200);
  expect(historical.value).toEqual({
    catalogueId: book.id,
    revisionId: book.firstPublicationId,
    kind: 'publication',
    sourceRevisionId: book.firstSourceId,
    title: 'Opening title at publication',
  });
  expectMetadataOnly(start);

  start = observer.records.length;
  const structure = await get(
    book.id,
    `?revisionId=${book.currentSourceId}&kind=structure&includeTitle=1`,
    f.author.bearer,
  );
  expect(structure.status).toBe(200);
  expect(structure.value).toMatchObject({ kind: 'structure', revisionId: book.currentSourceId });
  expect(structure.value).not.toHaveProperty('title');
  expectMetadataOnly(start);

  const draft = await f.thread('draft');
  const draftCatalogue = await f.command('/v1/hostedCatalogues', {
    postId: draft.firstPost.id,
    threadId: draft.id,
    placements: [],
  });
  start = observer.records.length;
  const privateDraft = await get(
    draft.firstPost.id,
    `?revisionId=${draftCatalogue.revisionId}&kind=structure&includeTitle=1`,
    f.author.bearer,
  );
  expect(privateDraft.status).toBe(200);
  expect(privateDraft.value).not.toHaveProperty('title');
  expectMetadataOnly(start);

  const otherRoute = await f.call('GET', `/v1/hostedCatalogues/${book.id}/children?includeTitle=1`);
  expect(otherRoute.status).toBe(400);
});

test('a changed retained opening observation withholds its title until a fresh read', async () => {
  const nativeRead = reads.readPostMetadata;
  let changed = false;
  const hook = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
    const result = await nativeRead(...args);
    if (args[2] === book.id && !changed) {
      changed = true;
      const revised = await f.revise(
        { id: book.id, revisionId: book.postRevisionId, visibility: 'published' },
        { title: 'Retained title changed' },
      );
      expect(revised.status).toBe(200);
      book.postRevisionId = revised.value.post.revisionId;
    }
    return result;
  });
  const start = observer.records.length;
  try {
    const withheld = await get(book.id, '?includeTitle=1');
    expect(changed).toBe(true);
    expect(withheld.status).toBe(404);
    expect(withheld.value).not.toHaveProperty('title');
  } finally {
    hook.mockRestore();
  }
  expectMetadataOnly(start);

  const freshStart = observer.records.length;
  const fresh = await get(book.id, '?includeTitle=1');
  expect(fresh.status).toBe(200);
  expect(fresh.value.title).toBe('Retained title changed');
  expectMetadataOnly(freshStart);
});
