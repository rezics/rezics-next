import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { publicationNoticesFixture } from './support/publication-notices-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof publicationNoticesFixture>>;
beforeAll(async () => {
  f = await publicationNoticesFixture();
});
afterAll(async () => {
  await f?.close();
});

test('delayed draft creation mentions A, first publication mentions B, and a newer head cannot replace B', async () => {
  const {
    mentioned: a,
    readers: [b, c],
  } = f.people;
  const thread = await f.thread();
  const draft = await f.reply(thread, [a], 'draft');
  const edited = await f.revise(draft, [a]);
  const key = crypto.randomUUID();
  const published = await f.revise(edited, [b!], 'published', f.people.replier, key);
  await f.revise(published, [c!]);
  expect(await f.revise(edited, [b!], 'published', f.people.replier, key)).toEqual(published);
  // No creation relay ran before publication or the newer head committed.
  await f.deliver();
  expect(await f.inbox(a, draft)).toEqual([]);
  expect(await f.inbox(b!, draft)).toEqual([expect.objectContaining({ kind: 'mention' })]);
  expect(await f.inbox(c!, draft)).toEqual([]);
  expect(await f.notices(draft)).toEqual(
    expect.arrayContaining([
      { recipient_id: b!.id, kind: 'mention' },
      { recipient_id: f.people.author.id, kind: 'reply' },
    ]),
  );
  expect(await f.notices(draft)).toHaveLength(2);
  await f.deliver(true);
  expect(await f.notices(draft)).toHaveLength(2);
});

test('draft creation and edits stay silent; opening publication and immediate replies notify once with reply precedence', async () => {
  const {
    mentioned,
    author,
    replier,
    readers: [later],
  } = f.people;
  const draft = await f.thread([mentioned], 'draft');
  const edited = await f.revise(draft.firstPost, [mentioned], 'draft', author);
  await f.deliver();
  expect(await f.notices(edited)).toEqual([]);
  const opening = await f.revise(edited, [mentioned], 'published', author);
  const immediate = await f.thread([mentioned]);
  const reply = await f.reply(immediate, [author, author, mentioned, mentioned, replier]);
  await f.deliver();
  for (const post of [opening, immediate.firstPost, reply])
    expect(await f.inbox(mentioned, post)).toEqual([expect.objectContaining({ kind: 'mention' })]);
  expect(await f.notices(reply)).toHaveLength(2);
  expect(await f.inbox(author, reply)).toEqual([expect.objectContaining({ kind: 'reply' })]);
  await f.revise(opening, [later!], undefined, author);
  await f.revise(reply, [later!]);
  await f.deliver();
  await f.deliver(true);
  for (const post of [opening, immediate.firstPost, reply]) expect(await f.inbox(later!, post)).toEqual([]);
  expect(await f.notices(reply)).toHaveLength(2);
});

test('current recipient authority, preferences and ancestor disclosure govern publication sends', async () => {
  const {
    mentioned,
    author,
    readers: [controlRecipient, preferenceRecipient],
  } = f.people;
  const protectedThread = await f.thread([], 'published', f.people.protectedBoardId);
  const denied = await f.reply(protectedThread, [mentioned]);
  await f.call(mentioned, 'GET', `/v1/posts/${denied.id}`);
  await f.setup.realmMember(mentioned, false);
  await f.setup.setPreference(author, 'reply', false);
  const publicThread = await f.thread();
  const ancestorDenied = await f.reply(publicThread, [mentioned], 'published', publicThread.firstPost.id);
  await f.call(mentioned, 'GET', `/v1/posts/${ancestorDenied.id}`);
  const preferenceDenied = await f.reply(await f.thread(), [preferenceRecipient!]);
  await f.setup.setPreference(preferenceRecipient!, 'mention', false);
  const control = await f.reply(await f.thread(), [controlRecipient!]);
  await f.takeDown(publicThread.firstPost, publicThread);
  await f.deliver();
  for (const post of [denied, ancestorDenied, preferenceDenied]) expect(await f.notices(post)).toEqual([]);
  expect(await f.inbox(controlRecipient!, control)).toEqual([expect.objectContaining({ kind: 'mention' })]);
  await f.setup.realmMember(mentioned, true);
  await f.setup.setPreference(author, 'reply', true);
  await f.setup.setPreference(preferenceRecipient!, 'mention', true);
  await f.deliver(true);
  for (const post of [denied, ancestorDenied, preferenceDenied]) expect(await f.notices(post)).toEqual([]);
});
