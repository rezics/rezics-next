import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { repairOwnDraftPage } from '../../src/content/own-drafts-index.ts';
import { readBatch } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  f = await postPublicationFixture();
});
afterAll(async () => {
  await f?.close();
});

// The same registered effect consumes real committed envelopes after releasing
// the source log checkout, as in production. No locator is fixture-seeded.
async function deliver(id: string, pool: Pool = f.pool) {
  const events: Parameters<ReturnType<typeof createAuthorItemEffect>['run']>[0][] = [];
  const effect = createAuthorItemEffect(pool);
  for (;;) {
    const page = await readBatch(pool, {
      partition: partitionOf(routeOf(id)!),
      consumer: `drafts_${id.replaceAll('-', '')}`,
      apply: async (envelopes) => {
        for (const envelope of envelopes)
          events.push(...envelope.events.filter((event) => effect.types.includes(event.type)));
      },
    });
    if (page.status !== 'read') throw new Error('Native draft source log is unavailable');
    if (page.envelopes < 64) break;
  }
  for (const event of events) await effect.run(event);
  return events;
}

const home = () => `/v1/accounts/${f.author.actor.accountId}/drafts`;
test('acknowledged native draft returns privately, resumes exact bytes, conflicts, recovers and publishes once', async () => {
  const thread = await f.thread('draft');
  const post = thread.firstPost;
  await deliver(post.id);
  const second = await f.system.auth.issue({
    accountId: f.author.actor.accountId,
    clientId: f.system.auth.ordinaryClient.id,
    scopes: f.system.auth.ordinaryScopes,
  });
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${home()}`, {
      headers: { authorization: `Bearer ${second.bearer}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = (await response.json()) as any;
  expect(page.drafts.find((item: any) => item.id === post.id)).toMatchObject({
    threadId: thread.id,
    firstPostId: post.id,
    revisionId: post.revisionId,
    title: 'Publication',
    kind: 'discussion',
    licence: 'MIT',
    actions: {
      resume: expect.any(String),
      edit: expect.any(String),
      publish: expect.any(String),
      erase: expect.any(String),
    },
  });
  expect(page.drafts[0]).not.toHaveProperty('body');
  const resume = `${home()}/${post.id}?threadId=${thread.id}`;
  const selected = await f.call('GET', resume);
  expect(selected.status).toBe(200);
  expect(selected.value.post).toMatchObject({
    revisionId: post.revisionId,
    body: fromPlainText('Opening'),
    licence: 'MIT',
  });
  expect((await f.call('GET', resume, undefined, { other: true })).status).toBe(404);
  const key = crypto.randomUUID();
  const input = { body: fromPlainText('Acknowledged second-device edit'), visibility: 'draft' };
  const saved = await f.revise(post, input, { key });
  expect(saved.status).toBe(200);
  expect((await f.revise(post, input, { key })).value.post).toEqual(saved.value.post);
  expect((await f.revise(post, { body: fromPlainText('Concurrent device') })).status).toBe(412);
  expect((await f.call('GET', resume)).value.post).toEqual(saved.value.post);
  await deliver(post.id);
  expect((await f.call('GET', home())).value.drafts.find((item: any) => item.id === post.id).revisionId).toBe(
    saved.value.post.revisionId,
  );
  const published = await f.revise(saved.value.post, { body: input.body, visibility: 'published' });
  expect(published.status).toBe(200);
  await deliver(post.id);
  expect((await f.call('GET', home())).value.drafts.some((item: any) => item.id === post.id)).toBe(false);
  expect((await f.call('GET', resume)).status).toBe(404);
});

test('private inventory denies anonymous and unrelated actors and never widens public author lists', async () => {
  const thread = await f.thread('draft');
  await deliver(thread.firstPost.id);
  expect((await f.call('GET', home(), undefined, { anonymous: true })).status).toBe(401);
  expect((await f.call('GET', home(), undefined, { other: true })).status).toBe(404);
  const publicPage = await f.call('GET', `/v1/accounts/${f.author.actor.accountId}/threads`);
  expect(publicPage.status).toBe(200);
  expect(publicPage.value.threads.some((item: any) => item.id === thread.id)).toBe(false);
  const page = await f.call('GET', `${home()}?limit=1`);
  expect(page.status).toBe(200);
  expect(page.value.next).toBeString();
  expect((await f.call('GET', `${home()}?limit=2&cursor=${page.value.next}`)).status).toBe(400);
  expect((await f.call('GET', `${home()}?limit=1&cursor=${page.value.next}`, undefined, { other: true })).status).toBe(
    404,
  );
});

test('pending locators are preparing, bounded repair returns the draft, and late creation cannot resurrect an erase', async () => {
  const thread = await f.thread('draft');
  const before = await f.call('GET', home());
  expect(before.status).toBe(200);
  expect(before.value.state).toBe('preparing');
  let complete = false;
  for (let page = 0; page < 20 && !complete; page++) {
    const repaired = await repairOwnDraftPage(f.pool);
    expect(repaired.examined).toBeLessThanOrEqual(20);
    complete = repaired.complete;
  }
  expect(complete).toBe(true);
  const repaired = await f.call('GET', home());
  expect(repaired.value.state).toBe('ready');
  expect(repaired.value.drafts.some((item: any) => item.id === thread.firstPost.id)).toBe(true);
  const events = await deliver(thread.firstPost.id);
  const erased = await f.system.kernel.handle(
    new Request(`https://content.test/v1/posts/${thread.firstPost.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${f.author.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
    }),
  );
  expect(erased.status).toBe(204);
  await deliver(thread.firstPost.id);
  const effect = createAuthorItemEffect(f.pool);
  for (const event of events) await effect.run(event);
  expect((await f.call('GET', home())).value.drafts.some((item: any) => item.id === thread.firstPost.id)).toBe(false);
});

test('native review draft retains original Subject, root language, licence and canonical bytes on return', async () => {
  const r = await createReviewLifecycleFixture();
  try {
    const body = fromPlainText('Review retained through another session');
    body.doc.attrs = { ...body.doc.attrs, lang: 'zh-Hant' };
    const created = await r.call('POST', '/v1/threads', {
      bearer: r.author.bearer,
      body: {
        kind: 'review',
        title: 'Private review',
        body,
        licence: 'CC-BY-4.0',
        boardId: r.boardId,
        subjectIds: [r.subjectId],
        visibility: 'draft',
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const thread = created.value.thread;
    await deliver(thread.firstPost.id, r.system.database.pool);
    const path = `/v1/accounts/${r.author.accountId}/drafts`;
    const page = await r.call('GET', path, { bearer: r.author.bearer });
    expect(page.response.status, page.text).toBe(200);
    expect(page.value.drafts).toMatchObject([
      {
        kind: 'review',
        language: 'zh-Hant',
        licence: 'CC-BY-4.0',
        subjectIds: [r.subjectId],
        revisionId: thread.firstPost.revisionId,
      },
    ]);
    const selected = await r.call('GET', `${path}/${thread.firstPost.id}?threadId=${thread.id}`, {
      bearer: r.author.bearer,
    });
    expect(selected.response.status, selected.text).toBe(200);
    expect(selected.value.post.body).toEqual(thread.firstPost.body);
    expect(selected.value.post.sha256).toBe(thread.firstPost.sha256);
  } finally {
    await r.close();
  }
});
