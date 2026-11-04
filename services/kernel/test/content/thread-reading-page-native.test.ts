import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createContentReadingCardBatch, type SelectedReadingCardReference } from '../../src/content/reading-page.ts';
import { listThreadPosts } from '../../src/content/reads.ts';
import counts from '../../src/content/reaction-count-page.sql';
import { newId, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import { createThreadReadingPageFixture } from './support/thread-reading-page-fixture.ts';

let f: Awaited<ReturnType<typeof createThreadReadingPageFixture>>;
const anonymous = { kind: 'anonymous' } as const;
const deadline = () => Date.now() + 120_000;
beforeAll(async () => { f = await createThreadReadingPageFixture(); }, 240_000);
afterAll(async () => { await f?.close(); });
let window = 0;
beforeEach(async () => {
  // Keep ordinary production rate budgets; each journey starts in a fresh minute.
  await f.setTime(Date.now() + ++window * 60_000);
});

test('mounted personas retain exact opening/reply revisions, cursor, guest controls and concealment', async () => {
  const thread = await f.thread();
  const posts = [];
  for (let i = 0; i < 22; i++) posts.push(await f.post(thread.id, `Exact reply ${i}`));
  const first = await f.page(thread.id);
  expect(first.response.status, first.text).toBe(200);
  expect(first.value.thread.firstPost.revisionId).toBe(thread.firstPost.revisionId);
  expect(first.value.replies.items.map((post: any) => [post.id, post.revisionId])).toEqual(
    posts.slice(0, 20).map((post) => [post.id, post.revisionId]),
  );
  expect(first.value.actions.reply).toEqual({ state: 'sign_in_required' });
  expect(first.value.watch).toEqual({ state: 'sign_in_required' });
  const next = await f.page(thread.id, undefined, first.value.replies.next);
  expect(next.response.status, next.text).toBe(200);
  expect(next.value.query.cursor).toBe(first.value.replies.next);
  expect(next.value.replies.items.map((post: any) => post.id)).toEqual(posts.slice(20).map((post) => post.id));
  expect(next.value.replies.next).toBeNull();
  const author = await f.page(thread.id, f.author.bearer);
  expect(author.response.status, author.text).toBe(200);
  expect(author.response.headers.get('cache-control')).toBe('private, no-store');
  expect(author.value.actions.reply.state).toBe('available');
  const exactAction = author.value.actions.references.find((reference: any) => reference.id === posts[0].id);
  expect(exactAction.sourceRevisionId).toBe(posts[0].revisionId);
  const moderator = f.system.actors.moderator;
  await f.grant(thread.id, moderator.actor.accountId, ['post:create', 'moderation:takedown']);
  const moderated = await f.page(thread.id, moderator.bearer);
  expect(moderated.response.status, moderated.text).toBe(200);
  expect(moderated.value.actions.reply.state).toBe('available');
  const suspended = await f.page(thread.id, f.system.actors.suspended.bearer);
  expect(suspended.response.status, suspended.text).toBe(401);
  expect(suspended.value.code).toBe('invalid_credentials');
  await f.checked('POST', `/v1/threads/${thread.id}:takeDown`, {
    bearer: moderator.bearer, body: { reason: 'Conceal the reading target' },
  }, 200);
  const concealed = await f.page(thread.id);
  const missing = await f.page(newId(routeOf(thread.id)!));
  expect(concealed.response.status).toBe(404);
  expect(missing.response.status).toBe(404);
  expect(concealed.value.code).toBe(missing.value.code);
  expect(concealed.text).not.toContain('Exact opening');
}, 240_000);

test('native signed reply cursors bind account, client and authentication epoch', async () => {
  const thread = await f.thread();
  await f.post(thread.id, 'Cursor remainder');
  const actor = f.system.actors.author.actor;
  const selected = await listThreadPosts(f.dependencies, thread.id, { actor, deadline: deadline() }, undefined, 1);
  expect(selected.nextCursor).not.toBeNull();
  for (const switched of [
    f.system.actors.other.actor,
    { ...actor, clientId: `${actor.clientId}-other` },
    { ...actor, authnEpoch: actor.authnEpoch + 1 },
  ]) {
    await expect(listThreadPosts(f.dependencies, thread.id, { actor: switched, deadline: deadline() }, selected.nextCursor!, 1))
      .rejects.toThrow('Invalid content cursor');
  }
  const resumed = await listThreadPosts(f.dependencies, thread.id, { actor, deadline: deadline() }, selected.nextCursor!, 1);
  expect(resumed.entries).toHaveLength(1);
});

test('selected exact cards detect ancestor changes and keep original keys on retry', async () => {
  const thread = await f.thread();
  const parent = await f.post(thread.id, 'Original parent');
  const child = await f.post(thread.id, 'Selected child', parent.id);
  const selected: SelectedReadingCardReference[] = [{
    type: 'content.post', id: child.id, threadId: thread.id, placeId: f.boardId,
    threadRevisionId: thread.firstPost.revisionId, sourceRevisionId: child.revisionId,
  }];
  const prepare = () => createContentReadingCardBatch(f.dependencies, selected, anonymous, deadline());
  const pending = await prepare();
  await f.revise(parent.id, parent.revisionId, 'Revised ancestor');
  await expect(pending.finish()).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect(pending.selected).toEqual(selected);
  const retry = await (await prepare()).finish();
  expect(retry.selected[0]).toMatchObject({ reference: selected[0], state: 'current', source: { sourceRevisionId: child.revisionId } });
  expect(retry.anchors.length).toBeGreaterThan(0);
  const beforeEdit = await prepare();
  await f.revise(child.id, child.revisionId, 'New selected revision');
  await expect(beforeEdit.finish()).rejects.toMatchObject({ code: 'dependency_unavailable' });
  await expect(prepare()).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect(selected[0]!.sourceRevisionId).toBe(child.revisionId);
});

test('mounted withheld and erased replies disclose no protected body, identity or controls', async () => {
  const thread = await f.thread();
  const hidden = await f.post(thread.id, 'Hidden reply bytes');
  const erased = await f.post(thread.id, 'Erased reply bytes');
  const moderator = f.system.actors.moderator;
  await f.grant(hidden.id, moderator.actor.accountId, ['moderation:takedown']);
  await f.checked('POST', `/v1/posts/${hidden.id}:takeDown`, {
    bearer: moderator.bearer, body: { reason: 'Hide exact reply' },
  }, 200);
  await f.checked('DELETE', `/v1/posts/${erased.id}`, { bearer: f.author.bearer }, 204);
  const page = await f.page(thread.id);
  expect(page.response.status, page.text).toBe(200);
  for (const id of [hidden.id, erased.id]) {
    const entry = page.value.replies.items.find((post: any) => post.id === id);
    expect(entry).toMatchObject({ body: null, sha256: null, removed: true });
    for (const key of ['authorId', 'revisionId', 'decisionId', 'reactions', 'viewerReaction']) expect(entry).not.toHaveProperty(key);
    expect(page.value.actions.references.some((reference: any) => reference.id === id)).toBe(false);
  }
  expect(JSON.stringify(page.value)).not.toContain('Hidden reply bytes');
  expect(JSON.stringify(page.value)).not.toContain('Erased reply bytes');
});

test('a raw invisible candidate inserted during hydration cannot certify a different original frontier', async () => {
  const now = Date.now() + 10 * 60_000;
  await f.setTime(now + 30_000);
  const thread = await f.thread();
  const reply = await f.post(thread.id, 'Stable disclosed reply');
  const observer = observeSql(f.system.database.pool);
  let pending: ReturnType<typeof f.page> | undefined;
  const barrier = observer.hold({ statement: counts.sql }, 'before');
  try {
    pending = f.page(thread.id);
    await barrier.entered;
    await f.setTime(now + 15_000);
    await f.post(thread.id, 'Invisible draft candidate', undefined, 'draft');
    barrier.release();
    const result = await pending;
    expect(result.response.status, result.text).toBe(503);
    expect(result.value.code).toBe('dependency_unavailable');
    const retry = await f.page(thread.id);
    expect(retry.response.status, retry.text).toBe(200);
    expect(retry.value.replies.items.map((post: any) => post.id)).toEqual([reply.id]);
    expect(JSON.stringify(retry.value)).not.toContain('Invisible draft candidate');
  } finally {
    barrier.release();
    await pending?.catch(() => {});
    await observer.close();
    await f.setTime(Date.now());
  }
}, 240_000);
