import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: typeof owner;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  const scopes = ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete'];
  owner = await f.identity(scopes);
  other = await f.identity(scopes);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('a curator removes and restores exactly one duplicate occurrence with original note placement and identity while sibling membership survives', async () => {
  const subjectId = await f.createSubject('game');
  const made = await f.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Private occurrences',
    visibility: 'private',
  });
  expect(made.status).toBe(201);
  const collection = (await made.json()).collection;
  const root = `/v1/collections/${collection.id}`,
    members = root + '/members';
  const add = async (note: string) => {
    const r = await f.send(owner.bearer, 'POST', members, { subjectId, note });
    expect(r.status).toBe(201);
    return (await r.json()).member;
  };
  const first = await add('original private note'),
    sibling = await add('independent sibling');
  expect(first.id).not.toBe(sibling.id);
  const current = await f.send(owner.bearer, 'GET', root);
  expect(current.status).toBe(200);
  const parentRevision = (await current.json()).collection.revision;
  const path = `${members}/${first.id}`,
    key = entryKey();
  const deleted = await f.send(owner.bearer, 'DELETE', `${path}?revision=${parentRevision}`, undefined, key);
  expect(deleted.status).toBe(204);
  const deletionId = deleted.headers.get('Library-Collection-Member-Deletion-Id');
  const revision = Number(deleted.headers.get('Library-Collection-Member-Deletion-Revision'));
  expect(deletionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(revision).toBeGreaterThan(parentRevision);
  const after = await f.send(owner.bearer, 'GET', members);
  expect(after.status).toBe(200);
  expect((await after.json()).members.map((m: { id: string }) => m.id)).toEqual([sibling.id]);
  const denied = await f.send(other.bearer, 'POST', path + ':restore', { deletionId, revision });
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('original private note');
  const restored = await f.send(owner.bearer, 'POST', path + ':restore', { deletionId, revision });
  expect(restored.status).toBe(200);
  expect((await restored.json()).member).toMatchObject({
    id: first.id,
    subjectId,
    note: first.note,
    addedAt: first.addedAt,
  });
  const page = await f.send(owner.bearer, 'GET', members);
  expect(page.status).toBe(200);
  expect((await page.json()).members.map((m: { id: string }) => m.id)).toEqual([first.id, sibling.id]);
  const replay = await f.send(owner.bearer, 'DELETE', `${path}?revision=${parentRevision}`, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get('Library-Collection-Member-Deletion-Id')).toBe(deletionId);
  const final = await f.send(owner.bearer, 'GET', root);
  expect(final.status).toBe(200);
  expect((await final.json()).collection.memberCount).toBe(2);
}, 120000);
