import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { documentText, fromPlainText } from '@rezics/document';
import * as revisionPages from '../../src/content/revision-pages.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createContentDisclosureDriver } from './disclosure-driver.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';
import * as nativeSystem from './support/native-system.ts';

setDefaultTimeout(180_000);
let driver: Awaited<ReturnType<typeof createContentDisclosureDriver>>;
let system: nativeSystem.NativeContentSystem;
beforeAll(async () => {
  const create = nativeSystem.createNativeContentSystem;
  const observation = spyOn(nativeSystem, 'createNativeContentSystem').mockImplementation(async (...args) => {
    system = await create(...args);
    return system;
  });
  try {
    driver = await createContentDisclosureDriver();
  } finally {
    observation.mockRestore();
  }
});
afterAll(async () => driver?.close());

async function read(path: string, persona: 'anonymous' | 'author' | 'suspended' = 'anonymous') {
  const actor = persona === 'anonymous' ? null : system.actors[persona];
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
    }),
  );
}
async function page(path: string) {
  const response = await read(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
  return response.json();
}
async function fixture() {
  const board = await driver.board();
  const thread = await driver.publish({ board, body: 'Conversation opening' });
  const post = await driver.publish({ board, thread, body: 'First revision' });
  return { thread, post, path: `/v1/posts/${post.id}/revisions` };
}

test('mounted native history pages 20/21 exact revisions without changing the current post', async () => {
  const { thread, post, path } = await fixture();
  const ids = [post.revision.id];
  for (let i = 1; i <= 20; i++) ids.push((await driver.edit(post, `Revision ${i}`)).id);
  const before = await driver.inspectCommandCopies(post);
  const first = await page(path);
  expect(Object.keys(first).sort()).toEqual(['next', 'page', 'revisions']);
  expect(first.revisions.map((value: { revisionId: string }) => value.revisionId)).toEqual(ids.slice(0, 20));
  expect(first.page).toMatchObject({
    viewer: { kind: 'anonymous' },
    conversation: { id: thread.id, kind: 'discussion' },
    board: { id: first.page.conversation.boardId },
    head: { postId: post.id, revisionId: ids.at(-1), state: 'current' },
    currentness: { source: 'current', conversation: 'current', board: 'current', head: 'current' },
    reviewScores: { state: 'current', items: [] },
  });
  expect(first.page.place.kind).toBe('global');
  expect(first.page.navigation.exact).toEqual(
    first.revisions.map((revision: { id: string; revisionId: string }) => ({
      postId: revision.id,
      revisionId: revision.revisionId,
    })),
  );
  expect(first.page.navigation.compareToHead).toHaveLength(20);
  expect(
    first.page.authors.items.find((author: { id: string }) => author.id === first.revisions[0].authorId)?.state,
  ).toBe('available');
  expect(
    first.page.actions.references
      .filter((reference: { type: string }) => reference.type === 'content.post')
      .every((reference: { sourceRevisionId: string }) => reference.sourceRevisionId === ids.at(-1)),
  ).toBe(true);
  const second = await page(`${path}?cursor=${encodeURIComponent(first.next)}`);
  expect(second.revisions.map((value: { revisionId: string }) => value.revisionId)).toEqual(ids.slice(20));
  expect(second.next).toBeNull();
  expect((await page(`${path}?limit=100`)).revisions).toHaveLength(21);
  expect((await page(`${path}?limit=1`)).revisions[0].revisionId).toBe(ids[0]);
  const exact = await driver.read('anonymous', post, ids[0]);
  expect(exact.response.status).toBe(200);
  expect(exact.value?.revision.body).toBe('First revision');
  expect((await read(`/v1/posts/${post.id}/revisions/${ids[0]}`)).status).toBe(200);
  const edition = await read(`/v1/posts/${post.id}/revisions/${ids[0]}?editionIdentity=true`);
  expect(edition.status).toBe(200);
  expect(edition.headers.get('cache-control')).toBe('private, no-store');
  expect((await driver.read('author', post)).value?.revision.id).toBe(ids.at(-1)!);
  expect(documentText(first.revisions[0].body)).toBe('First revision');
  const authenticated = await read(path, 'author');
  expect(authenticated.status).toBe(200);
  expect(await authenticated.json()).toMatchObject({
    page: { viewer: { kind: 'account', id: system.actors.author.actor.accountId } },
  });
  expect((await read(path, 'suspended')).status).toBe(401);
  expect((await read(`${path}?cursor=${encodeURIComponent(first.next)}`, 'author')).status).toBe(400);
  for (const limit of [0, 101]) expect((await read(`${path}?limit=${limit}`)).status).toBe(400);
  expect(await driver.inspectCommandCopies(post)).toEqual(before);
});

test('a changed source withholds all selected bodies and same-cursor retry retains exact keys', async () => {
  const { post, path } = await fixture();
  const secondId = (await driver.edit(post, 'Second revision')).id;
  const first = await page(`${path}?limit=1`);
  const nextPath = `${path}?limit=1&cursor=${encodeURIComponent(first.next)}`;
  const select = revisionPages.pageRevisionCandidates;
  const observation = spyOn(revisionPages, 'pageRevisionCandidates').mockImplementationOnce(async (...args) => {
    const selected = await select(...args);
    await driver.edit(post, 'Changed during selection');
    return selected;
  });
  try {
    const response = await read(nextPath);
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
    expect(await response.text()).not.toContain('Second revision');
  } finally {
    observation.mockRestore();
  }
  const retry = await page(nextPath);
  expect(retry.revisions[0].revisionId).toBe(secondId);
  expect(documentText(retry.revisions[0].body)).toBe('Second revision');
});

test('current takedown during hydration withholds the page, including an empty selection', async () => {
  const { post, path } = await fixture();
  const select = revisionPages.pageRevisionCandidates;
  const observation = spyOn(revisionPages, 'pageRevisionCandidates').mockImplementationOnce(async (...args) => {
    await select(...args);
    const removed = await driver.takedown('moderator', post, crypto.randomUUID());
    expect(removed.response.status).toBe(200);
    return { candidates: [], nextKey: null };
  });
  try {
    const response = await read(path);
    expect(response.status).toBe(404);
    expect(response.headers.get(SESSION_HEADER)).toBeNull();
  } finally {
    observation.mockRestore();
  }
});

test('history keeps the recorded review score, question scale and current title', async () => {
  const review = await createReviewLifecycleFixture();
  try {
    const route = routeOf(review.author.accountId)!;
    const firstCitation = { questionId: STANDARD_QUESTION_ID, units: 0, revision: 1 };
    const laterCitation = { questionId: STANDARD_QUESTION_ID, units: 17, revision: 2 };
    await review.admin.query(
      `INSERT INTO rating.vote(route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
       VALUES ($1, $2, $3, $4, 0, 1, now(), $5)`,
      [route, review.author.accountId, STANDARD_QUESTION_ID, review.subjectId, newId(route)],
    );
    const created = await review.call('POST', '/v1/threads', {
      bearer: review.author.bearer,
      body: {
        kind: 'review',
        title: 'Original review title',
        body: fromPlainText('Original review body.'),
        licence: 'CC-BY-4.0',
        boardId: review.boardId,
        subjectIds: [review.subjectId],
        visibility: 'published',
        voteCitation: firstCitation,
      },
    });
    expect(created.response.status).toBe(201);
    const thread = created.value.thread;
    const firstPost = thread.firstPost;
    await review.admin.query(
      `UPDATE rating.vote SET units=17, revision=2, changed_at=now(), transaction_id=$4
       WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$5`,
      [route, review.author.accountId, STANDARD_QUESTION_ID, newId(route), review.subjectId],
    );
    const revised = await review.call('POST', `/v1/posts/${firstPost.id}/revisions`, {
      bearer: review.author.bearer,
      ifMatch: firstPost.revisionId,
      body: {
        title: 'Current review title',
        body: fromPlainText('Revised review body.'),
        licence: 'CC-BY-4.0',
        voteCitation: laterCitation,
      },
    });
    expect(revised.response.status).toBe(200);

    const history = await review.call('GET', `/v1/posts/${firstPost.id}/revisions`);
    expect(history.response.status).toBe(200);
    expect(history.response.headers.get('cache-control')).toBe('private, no-store');
    expect(history.value.revisions.map((revision: { voteCitation: unknown }) => revision.voteCitation)).toEqual([
      firstCitation,
      laterCitation,
    ]);
    expect(history.value.page.conversation.title).toBe('Current review title');
    expect(history.value.page.reviewScores.items.map((item: { citation: unknown }) => item.citation)).toEqual([
      firstCitation,
      laterCitation,
    ]);
    expect(history.value.page.reviewScores.items[0].citation.units).toBe(0);
    expect(history.value.page.reviewScores.items[0].question.scale).toEqual({ min: 0, max: 20, displayStep: 1 });
    expect(history.value.page.head.revisionId).toBe(revised.value.post.revisionId);
  } finally {
    await review.close();
  }
});

test('a concealed current author keeps immutable revision authorship with a safe identity state', async () => {
  const { post, path } = await fixture();
  const authorId = system.actors.author.actor.accountId;
  const prior = await system.database.pool.query<{ authn_fenced: boolean }>(
    'SELECT authn_fenced FROM access.account WHERE account_id = $1',
    [authorId],
  );
  expect(prior.rows).toHaveLength(1);
  await system.database.pool.query('UPDATE access.account SET authn_fenced = true WHERE account_id = $1', [authorId]);
  try {
    const result = await page(path);
    expect(result.revisions[0].authorId).toBe(authorId);
    expect(result.page.authors.items.find((author: { id: string }) => author.id === authorId)).toEqual({
      id: authorId,
      state: 'concealed',
    });
  } finally {
    await system.database.pool.query('UPDATE access.account SET authn_fenced = $2 WHERE account_id = $1', [
      authorId,
      prior.rows[0]!.authn_fenced,
    ]);
  }
});
