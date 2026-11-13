import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import { repairHostedCataloguePage } from '../../src/content/hosted-chapters-index.ts';
import * as reads from '../../src/content/reads.ts';
import readChain from '../../src/content/read-chain.sql';
import { routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
let observer: ReturnType<typeof observeSql>;
const books: Array<{ id: string; threadId: string; revisionId: string; head: string; visibility: string }> = [];
const home = () => `/v1/accounts/${f.author.actor.accountId}/hostedCatalogues`;

beforeAll(async () => {
  f = await postPublicationFixture();
  for (const visibility of ['draft', 'published'] as const) {
    const thread = await f.thread(visibility);
    if (visibility === 'published') {
      const revised = await f.revise(thread.firstPost, { title: 'Bounded title '.repeat(70) });
      expect(revised.status).toBe(200);
      thread.firstPost = revised.value.post;
    }
    const created = await f.command('/v1/hostedCatalogues', {
      postId: thread.firstPost.id,
      threadId: thread.id,
      placements: [],
    });
    books.push({ ...thread.firstPost, threadId: thread.id, head: created.revisionId });
  }
  observer = observeSql(f.pool);
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});

async function get(suffix = '') {
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${home()}${suffix}`, {
      headers: { authorization: `Bearer ${f.author.bearer}` },
    }),
  );
  if (response.ok) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
  }
  return { status: response.status, value: await response.json() };
}

function expectNoBodies(start: number) {
  const probes = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every((row) => row.parameters[readChain.params.indexOf('include_body')] === false)).toBe(true);
}

test('owner list and exact get select zero bodies across scopes, coverage recovery and continuation', async () => {
  let start = observer.records.length;
  const partial = await get('?scope=all-homes');
  expect(partial.status).toBe(200);
  expect(partial.value.scope.crossHome).toBe('partial');
  expect(partial.value.items).toEqual([]);
  for (const book of books) {
    const exact = await get(`/${book.id}`);
    expect(exact.status).toBe(200);
    expect(exact.value.item).toEqual({
      catalogueId: book.id,
      threadId: book.threadId,
      createdAt: expect.any(String),
      postRevisionId: book.revisionId,
      postVisibility: book.visibility,
      title: book.visibility === 'draft' ? 'Publication' : 'Bounded title '.repeat(70).slice(0, 512),
      headRevisionId: book.head,
      publicationId: null,
    });
  }
  const same = await get();
  expect(same.status).toBe(200);
  expect(same.value.scope).toEqual({
    kind: 'same-home',
    route: routeOf(f.author.actor.accountId),
    crossHome: 'unavailable',
  });
  expect(same.value.items.map((item: { catalogueId: string }) => item.catalogueId).sort()).toEqual(
    books
      .filter((book) => routeOf(book.id) === routeOf(f.author.actor.accountId))
      .map((book) => book.id)
      .sort(),
  );
  expectNoBodies(start);

  for (let page = 0; ; page++) {
    expect(page).toBeLessThan(128);
    if ((await repairHostedCataloguePage(f.pool)).complete) break;
  }
  start = observer.records.length;
  const first = await get('?scope=all-homes&limit=1');
  expect(first.status).toBe(200);
  expect(first.value.scope.crossHome).toBe('complete');
  expect(first.value.items).toHaveLength(1);
  expect(first.value.nextCursor).toBeString();
  const next = await get(`?scope=all-homes&limit=1&cursor=${encodeURIComponent(first.value.nextCursor)}`);
  expect(next.status).toBe(200);
  expect(next.value.scope.crossHome).toBe('complete');
  expect(next.value.items).toHaveLength(1);
  expect(next.value.nextCursor).toBeNull();
  expect(
    [...first.value.items, ...next.value.items].map((item: { catalogueId: string }) => item.catalogueId).sort(),
  ).toEqual(books.map((book) => book.id).sort());
  for (const item of [...first.value.items, ...next.value.items])
    expect(item.title).toBe(
      item.postVisibility === 'draft' ? 'Publication' : 'Bounded title '.repeat(70).slice(0, 512),
    );
  for (const book of books)
    expect((await get(`/${book.id}`)).value.scope.crossHome).toBe(
      routeOf(book.id) === routeOf(f.author.actor.accountId) ? 'unavailable' : 'complete',
    );
  expectNoBodies(start);
});

test('list and exact get close the original metadata observation after a live source revision changes', async () => {
  const book = books[0]!;
  for (const exact of [false, true]) {
    const nativeRead = reads.readPostMetadata;
    let observations = 0;
    let retainedChecks = 0;
    const hook = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
      if (args[2] !== book.id) return nativeRead(...args);
      observations++;
      const retain = args[5]!;
      args[5] = (finish) =>
        retain(async (qualify) => {
          retainedChecks++;
          expect(qualify).toBeFunction();
          return finish(qualify);
        });
      const result = await nativeRead(...args);
      const revised = await f.revise(book, { title: `Retained title ${exact}` });
      expect(revised.status).toBe(200);
      book.revisionId = revised.value.post.revisionId;
      return result;
    });
    try {
      const selected = await get(exact ? `/${book.id}` : '?scope=all-homes');
      expect(observations).toBe(1);
      expect(retainedChecks).toBe(1);
      expect(selected.status).toBe(exact ? 404 : 200);
      if (exact) expect(selected.value).not.toHaveProperty('item');
      else expect(selected.value.items.map((item: { catalogueId: string }) => item.catalogueId)).not.toContain(book.id);
    } finally {
      hook.mockRestore();
    }
    const start = observer.records.length;
    const fresh = await get(`/${book.id}`);
    expect(fresh.status).toBe(200);
    expect(fresh.value.item.postRevisionId).toBe(book.revisionId);
    expect(fresh.value.item.title).toBe(`Retained title ${exact}`);
    expectNoBodies(start);
  }
});

test('reply catalogue anchors omit the conversation title and erased sources disclose no item', async () => {
  const thread = await f.thread();
  const post = await f.reply(thread.id);
  await f.command('/v1/hostedCatalogues', { postId: post.id, threadId: thread.id, placements: [] });
  let start = observer.records.length;
  const exact = await get(`/${post.id}`);
  expect(exact.status).toBe(200);
  expect(exact.value.item.catalogueId).toBe(post.id);
  expect(exact.value.item.postRevisionId).toBe(post.revisionId);
  expect(exact.value.item).not.toHaveProperty('title');
  expectNoBodies(start);
  const removed = await f.system.kernel.handle(
    new Request(`https://content.test/v1/posts/${post.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${f.author.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
    }),
  );
  expect(removed.status).toBe(204);
  start = observer.records.length;
  const erased = await get(`/${post.id}`);
  expect(erased.status).toBe(404);
  expect(erased.value).not.toHaveProperty('item');
  expectNoBodies(start);
});
