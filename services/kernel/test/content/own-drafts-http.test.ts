import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { Pool } from 'pg';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import { repairOwnDraftPage } from '../../src/content/own-drafts-index.ts';
import { readBatch } from '../../src/events/log.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';
import * as reads from '../../src/content/reads.ts';
import * as subjects from '../../src/content/edition-subject.ts';

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
// Inject a real command only after the final account snapshot has released its
// checkout. All observations and command authorization still use native Access.
async function duringFinalAdmission(path: string, change: () => Promise<void>) {
  const snapshot = reads.snapshot;
  let remaining = path === home() ? 3 : 2;
  const observe: typeof snapshot = async (...args) => {
    const result = await snapshot(...args);
    if (args[1] === f.author.actor.accountId && --remaining === 0) await change();
    return result;
  };
  const hook = spyOn(reads, 'snapshot').mockImplementation(observe);
  try {
    return await f.call('GET', path);
  } finally {
    hook.mockRestore();
  }
}

test('final private admission cannot return an earlier head or self-certify a refreshed draft', async () => {
  const thread = await f.thread('draft');
  const post = thread.firstPost;
  const path = `${home()}/${post.id}?threadId=${thread.id}`;
  const stale = await duringFinalAdmission(path, async () => {
    expect((await f.revise(post, { body: fromPlainText('Changed during return') })).status).toBe(200);
  });
  expect(stale.status).toBe(404);
  const retry = await f.call('GET', path);
  expect(retry.status).toBe(200);
  expect(retry.value.post.body).toEqual(fromPlainText('Changed during return'));
  await deliver(post.id);
  const page = await duringFinalAdmission(home(), async () => {
    expect((await f.revise(retry.value.post, { visibility: 'published' })).status).toBe(200);
  });
  expect(page.status).toBe(200);
  expect(page.value.drafts.some((item: any) => item.id === post.id)).toBe(false);
});

test('erasure after body hydration conceals exact resume and its acknowledged bytes', async () => {
  const thread = await f.thread('draft');
  const path = `${home()}/${thread.firstPost.id}?threadId=${thread.id}`;
  const result = await duringFinalAdmission(path, async () => {
    const erased = await f.system.kernel.handle(
      new Request(`https://content.test/v1/posts/${thread.firstPost.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${f.author.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      }),
    );
    expect(erased.status).toBe(204);
  });
  expect(result.status).toBe(404);
  expect(result.value).not.toHaveProperty('post');
});

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

test('missing locator coverage is unavailable and an exact cursor retry remains usable', async () => {
  await f.pool.query('UPDATE content.own_draft_progress SET complete=false WHERE singleton=0');
  await f.thread('draft');
  await f.thread('draft');
  let complete = false;
  for (let page = 0; page < 20 && !complete; page++) complete = (await repairOwnDraftPage(f.pool)).complete;
  expect(complete).toBe(true);

  await f.pool.query('UPDATE content.own_draft_progress SET complete=false WHERE singleton=0');
  const progress = await f.pool.query<{ after_route: number; after_thread: string; after_post: string }>(
    'SELECT after_route,after_thread,after_post FROM content.own_draft_progress WHERE singleton=0',
  );
  expect(progress.rows).toHaveLength(1);
  const first = await f.call('GET', `${home()}?limit=1`);
  expect(first.status).toBe(200);
  expect(first.value.state).toBe('preparing');
  expect(first.value.drafts).toHaveLength(1);
  expect(first.value.next).toBeString();
  const retryPath = `${home()}?limit=1&cursor=${encodeURIComponent(first.value.next)}`;

  await f.pool.query('DELETE FROM content.own_draft_progress WHERE singleton=0');
  try {
    const unavailable = await f.call('GET', retryPath);
    expect(unavailable.status).toBe(503);
    expect(unavailable.value.code).toBe('dependency_unavailable');
    const stillMissing = await f.pool.query('SELECT 1 FROM content.own_draft_progress WHERE singleton=0');
    expect(stillMissing.rows).toHaveLength(0);
  } finally {
    await f.pool.query(
      `INSERT INTO content.own_draft_progress (singleton,after_route,after_thread,after_post,complete)
       VALUES (0,$1,$2,$3,false)
       ON CONFLICT (singleton) DO UPDATE SET after_route=$1,after_thread=$2,after_post=$3,complete=false`,
      [progress.rows[0]!.after_route, progress.rows[0]!.after_thread, progress.rows[0]!.after_post],
    );
  }

  const retry = await f.call('GET', retryPath);
  expect(retry.status).toBe(200);
  expect(retry.value.state).toBe('preparing');
  expect(retry.value.drafts).toHaveLength(1);
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
    // A still-readable Subject is not the same identity observation. Change its
    // real producer while private list/resume are between their observations.
    for (const mode of ['list', 'resume']) {
      const prepare = subjects.prepareEditionSubjectIdentities;
      const hook = spyOn(subjects, 'prepareEditionSubjectIdentities').mockImplementation(async (...args) => {
        const read = await prepare(...args);
        let observations = 0;
        return async () => {
          if (++observations === 2) {
            const renamed = await r.call('PATCH', `/v1/subjects/${r.subjectId}/terms`, {
              bearer: r.author.bearer,
              body: { labels: { en: `Changed during ${mode}` } },
            });
            expect(renamed.response.status, renamed.text).toBe(200);
          }
          return read();
        };
      });
      const target = mode === 'list' ? path : `${path}/${thread.firstPost.id}?threadId=${thread.id}`;
      try {
        const changed = await r.call('GET', target, { bearer: r.author.bearer });
        expect(changed.response.status, changed.text).toBe(mode === 'list' ? 200 : 404);
        if (mode === 'list') expect(changed.value.drafts).toEqual([]);
      } finally {
        hook.mockRestore();
      }
      const retry = await r.call('GET', target, { bearer: r.author.bearer });
      expect(retry.response.status, retry.text).toBe(200);
      if (mode === 'list') expect(retry.value.drafts).toHaveLength(1);
      else expect(retry.value.post.body).toEqual(body);
    }
  } finally {
    await r.close();
  }
});
