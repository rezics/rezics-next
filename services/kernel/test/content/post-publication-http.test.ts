import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mentionDocument, postPublicationFixture, publicationType } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  f = await postPublicationFixture();
});
afterAll(async () => {
  await f?.close();
});
const publications = async (id: string) => (await f.evidence(id)).filter((event) => event.type === publicationType);

test('native draft A and silent edit publish B exactly once, pinning its actual revision across replay and later edits', async () => {
  const thread = await f.thread();
  const draft = await f.reply(thread.id, 'draft');
  expect(draft.visibility).toBe('draft');
  expect((await f.call('GET', `/v1/posts/${draft.id}`, undefined, { other: true })).status).toBe(404);
  expect(
    (
      await f.call('GET', `/v1/posts/${draft.id}`, undefined, {
        anonymous: true,
      })
    ).status,
  ).toBe(404);
  expect(await publications(draft.id)).toEqual([]);
  const edit = await f.revise(draft, { visibility: 'draft' });
  expect(edit.status).toBe(200);
  expect(edit.value.post.visibility).toBe('draft');
  const preserved = await f.revise(edit.value.post, {});
  expect(preserved.status).toBe(200);
  expect(preserved.value.post.visibility).toBe('draft');
  expect(await publications(draft.id)).toEqual([]);
  const key = crypto.randomUUID();
  const input = {
    body: mentionDocument(f.system.actors.moderator.actor.accountId),
    visibility: 'published',
  };
  const published = await f.revise(preserved.value.post, input, { key });
  expect(published.status).toBe(200);
  expect(published.value.post.visibility).toBe('published');
  expect(published.value.post.revisionId).not.toBe(preserved.value.post.revisionId);
  expect(await publications(draft.id)).toEqual([
    {
      type: publicationType,
      data: {
        threadId: thread.id,
        itemId: draft.id,
        revisionId: published.value.post.revisionId,
        actorId: f.author.actor.accountId,
        placeId: f.realm.realmId,
        kind: 'discussion',
        subjectIds: [],
        activityAt: expect.any(String),
      },
    },
  ]);
  const exact = await f.call('GET', `/v1/posts/${draft.id}/revisions/${published.value.post.revisionId}`);
  expect(exact.status).toBe(200);
  expect(exact.value.post.body).toEqual(input.body);
  const later = await f.revise(published.value.post, {});
  expect(later.status).toBe(200);
  const replay = await f.revise(preserved.value.post, input, { key });
  expect(replay.status).toBe(200);
  expect(replay.value.post.revisionId).toBe(published.value.post.revisionId);
  const before = await f.state(draft.id);
  expect((await f.revise(later.value.post, { visibility: 'draft' })).status).toBe(400);
  expect(await f.state(draft.id)).toEqual(before);
  expect(await publications(draft.id)).toHaveLength(1);
  expect((await f.evidence(draft.id)).filter((e) => e.type.endsWith('revision.created.v1'))).toHaveLength(4);
});

test('immediate opening and default/explicit published replies emit publication; opening transition changes both security states', async () => {
  const immediate = await f.thread();
  for (const post of [immediate.firstPost, await f.reply(immediate.id), await f.reply(immediate.id, 'published')]) {
    expect(await publications(post.id)).toMatchObject([{ data: { revisionId: post.revisionId } }]);
  }
  const key = crypto.randomUUID();
  const path = `/v1/threads/${immediate.id}/posts`;
  const input = { body: mentionDocument(f.author.actor.accountId), licence: 'MIT' };
  const created = await f.call('POST', path, input, { key });
  const replay = await f.call('POST', path, input, { key });
  expect(created.status).toBe(201);
  expect(replay.value.post).toEqual(created.value.post);
  expect(await publications(created.value.post.id)).toHaveLength(1);
  const draft = await f.thread('draft');
  expect(await publications(draft.firstPost.id)).toEqual([]);
  const before = await f.state(draft.firstPost.id);
  const published = await f.revise(draft.firstPost, {
    visibility: 'published',
  });
  expect(published.status).toBe(200);
  expect(await f.state(draft.firstPost.id)).toMatchObject({
    visibility: 'published',
    thread_visibility: 'published',
    head_revision_id: published.value.post.revisionId,
    security_revision: String(BigInt(before.security_revision) + 1n),
    thread_security_revision: String(BigInt(before.thread_security_revision) + 1n),
  });
  expect(
    (
      await f.call('GET', `/v1/threads/${draft.id}`, undefined, {
        anonymous: true,
      })
    ).status,
  ).toBe(200);
  expect(await publications(draft.firstPost.id)).toHaveLength(1);
});

test('closed visibility, stale heads and competing publication preserve a single winner', async () => {
  const thread = await f.thread();
  const draft = await f.reply(thread.id, 'draft');
  for (const visibility of ['protected', 'taken_down', null, true]) {
    expect((await f.revise(draft, { visibility })).status).toBe(400);
    expect(
      (
        await f.call('POST', `/v1/threads/${thread.id}/posts`, {
          body: mentionDocument(f.author.actor.accountId),
          licence: 'MIT',
          visibility,
        })
      ).status,
    ).toBe(400);
  }
  const attempts = await Promise.all([
    f.revise(draft, { visibility: 'published' }),
    f.revise(draft, { visibility: 'published' }),
  ]);
  expect(attempts.filter((result) => result.status === 200)).toHaveLength(1);
  expect([404, 412]).toContain(attempts.find((result) => result.status !== 200)!.status);
  expect((await f.revise(draft, { visibility: 'published' })).status).toBe(412);
  const events = await publications(draft.id);
  expect(events).toHaveLength(1);
  expect(events[0]!.data.revisionId).toBe((await f.state(draft.id)).head_revision_id);
});

test('publication event failure rolls back revision, opening/thread visibility and receipt, allowing the same request to retry', async () => {
  const thread = await f.thread('draft');
  const before = await f.state(thread.firstPost.id);
  const key = crypto.randomUUID();
  await f.pool.query(`CREATE FUNCTION public.reject_test_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type='com.rezics.content.post.published.v1' THEN RAISE EXCEPTION 'publication rollback fault'; END IF; RETURN NEW; END $$`);
  await f.pool.query(
    `CREATE TRIGGER reject_test_publication BEFORE INSERT ON core.outbox FOR EACH ROW EXECUTE FUNCTION public.reject_test_publication()`,
  );
  try {
    expect((await f.revise(thread.firstPost, { visibility: 'published' }, { key })).status).toBe(500);
    expect(await f.state(thread.firstPost.id)).toEqual(before);
    expect(await publications(thread.firstPost.id)).toEqual([]);
  } finally {
    await f.pool.query('DROP TRIGGER reject_test_publication ON core.outbox');
    await f.pool.query('DROP FUNCTION public.reject_test_publication()');
  }
  expect((await f.revise(thread.firstPost, { visibility: 'published' }, { key })).status).toBe(200);
  expect(await publications(thread.firstPost.id)).toHaveLength(1);
});

test('real denied actor, current ancestor loss, erasure and takedown refuse publication without mutation', async () => {
  const thread = await f.thread();
  const draft = await f.reply(thread.id, 'draft');
  const before = await f.state(draft.id);
  expect((await f.revise(draft, { visibility: 'published' }, { other: true })).status).toBe(404);
  expect(await f.state(draft.id)).toEqual(before);
  expect((await f.revise(thread.firstPost, { visibility: 'published' }, { other: true })).status).toBe(403);
  await f.command(`/v1/threads/${thread.id}:takeDown`, { reason: 'Ancestor unavailable' }, 200);
  const concealed = await f.state(draft.id);
  expect((await f.revise(draft, { visibility: 'published' })).status).toBe(404);
  expect(await f.state(draft.id)).toEqual(concealed);
  expect(await publications(draft.id)).toEqual([]);
  for (const operation of ['erase', 'takeDown']) {
    const scope = await f.thread();
    const post = await f.reply(scope.id, 'draft');
    const child = await f.reply(scope.id, 'draft', post.id);
    const childBefore = await f.state(child.id);
    await f.command(`/v1/posts/${post.id}:${operation}`, { reason: 'Unavailable' }, 200);
    const unavailable = await f.state(post.id);
    expect((await f.revise(post, { visibility: 'published' })).status).toBe(404);
    expect(await f.state(post.id)).toEqual(unavailable);
    expect(await publications(post.id)).toEqual([]);
    expect((await f.revise(child, { visibility: 'published' })).status).toBe(404);
    expect(await f.state(child.id)).toEqual(childBefore);
    expect(await publications(child.id)).toEqual([]);
  }
});
