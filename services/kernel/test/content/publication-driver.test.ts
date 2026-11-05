import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { ok, publicationDriverFixture, revision } from './support/publication-driver-fixture.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof publicationDriverFixture>>;
beforeAll(async () => {
  f = await publicationDriverFixture();
});
afterAll(async () => {
  await f?.close();
});

test('driver binds delayed draft A to native first publication B, preserving its revision across later edits and replay', async () => {
  const {
    mentioned: a,
    readers: [b, c],
  } = f.people;
  const thread = await f.thread();
  const created = await f.post(thread.id, [a], 'draft');
  const draft = ok(created, 201);
  const draftRevision = await revision(created, 'draft', 201);
  const editedResult = await f.revise(draft, [a], 'draft');
  const edited = ok(editedResult);
  expect(await revision(editedResult, 'draft')).not.toBe(draftRevision);
  const key = f.options();
  const publication = await f.revise(edited, [b!], 'published', key);
  const published = ok(publication);
  const publicationRevision = await revision(publication, 'published');
  const laterResult = await f.revise(published, [c!]);
  const later = ok(laterResult);
  const laterRevision = await revision(laterResult, 'published');
  expect(laterRevision).not.toBe(publicationRevision);
  // Both creation and publication remain undelivered until after the newer head.
  const replay = await f.revise(edited, [b!], 'published', key);
  expect(ok(replay)).toEqual(published);
  expect(await revision(replay, 'published')).toBe(publicationRevision);
  const stale = await f.revise(edited, [a]);
  expect(stale.response.status).toBe(412);
  expect(stale.value).toBeNull();
  expect(await stale.response.json()).toMatchObject({ status: 412 });
  const read = await f.driver.readPost(later, f.people.replier);
  expect(await revision(read, 'published')).toBe(laterRevision);
  await f.driver.effects('drain');
  const sent = await f.notices(b!, draft);
  expect(sent).toEqual([expect.objectContaining({ kind: 'mention', actorId: f.people.replier.id })]);
  for (const account of [a, c!]) expect(await f.notices(account, draft)).toEqual([]);
  expect(await f.notices(f.people.author, draft)).toEqual([expect.objectContaining({ kind: 'reply' })]);
  await f.driver.effects('replay');
  expect(await f.notices(b!, draft)).toEqual(sent);
  for (const account of [a, c!]) expect(await f.notices(account, draft)).toEqual([]);
});

test('driver forwards draft visibility, immediate publication and silent later edits', async () => {
  const {
    mentioned,
    readers: [later],
  } = f.people;
  const thread = await f.thread();
  const draft = ok(await f.post(thread.id, [mentioned], 'draft'), 201);
  const edited = await f.revise(draft, [mentioned], 'draft');
  await revision(edited, 'draft');
  await f.driver.effects('drain');
  for (const account of [mentioned, f.people.author]) expect(await f.notices(account, draft)).toEqual([]);
  const immediate = await f.post(thread.id, [mentioned]);
  await revision(immediate, 'published', 201);
  const post = ok(immediate, 201);
  await f.driver.effects('drain');
  const sent = await f.notices(mentioned, post);
  expect(sent).toEqual([expect.objectContaining({ kind: 'mention' })]);
  await revision(await f.revise(post, [later!]), 'published');
  await f.driver.effects('drain');
  await f.driver.effects('replay');
  expect(await f.notices(mentioned, post)).toEqual(sent);
  expect(await f.notices(later!, post)).toEqual([]);
});

test('registered driver delivery applies current membership and preferences without backfilling on replay', async () => {
  const {
    mentioned,
    readers: [preferenceRecipient, controlRecipient],
  } = f.people;
  const protectedThread = await f.thread(true);
  const denied = ok(await f.post(protectedThread.id, [mentioned]), 201);
  ok(await f.driver.readPost(denied, mentioned));
  await f.driver.fixtures.realmMember(mentioned, false);
  const publicThread = await f.thread();
  const preferenceDenied = ok(await f.post(publicThread.id, [preferenceRecipient!]), 201);
  const control = ok(await f.post(publicThread.id, [controlRecipient!]), 201);
  await f.driver.fixtures.notificationAllowed(preferenceRecipient!, 'mention', false);
  await f.driver.effects('drain');
  expect(await f.notices(mentioned, denied)).toEqual([]);
  expect(await f.notices(preferenceRecipient!, preferenceDenied)).toEqual([]);
  expect(await f.notices(controlRecipient!, control)).toEqual([expect.objectContaining({ kind: 'mention' })]);
  await f.driver.fixtures.realmMember(mentioned, true);
  await f.driver.fixtures.notificationAllowed(preferenceRecipient!, 'mention', true);
  await f.driver.effects('replay');
  expect(await f.notices(mentioned, denied)).toEqual([]);
  expect(await f.notices(preferenceRecipient!, preferenceDenied)).toEqual([]);
});
