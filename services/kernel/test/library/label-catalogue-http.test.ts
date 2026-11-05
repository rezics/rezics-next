import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native label catalogue HTTP uses the approved closed routes scopes minimal outcomes and ordinary restore without leaking another account catalogue', async () => {
  const key = entryKey();
  const created = await f.send('owner', 'POST', '/v1/libraryLabels', { name: '  HTTP   label ' }, key);
  expect(created.status).toBe(201);
  const first = await created.json();
  expect(Object.keys(first)).toEqual(['label']);
  expect(Object.keys(first.label).sort()).toEqual(['id', 'revision']);
  const { id, revision } = first.label,
    path = '/v1/libraryLabels/' + id;
  const listed = await f.send('owner', 'GET', '/v1/libraryLabels?limit=100');
  expect(listed.status).toBe(200);
  const page = await listed.json();
  expect(page.labels.find((x: { id: string }) => x.id === id)).toEqual({ id, name: 'HTTP label', revision });
  expect(page).toHaveProperty('next');
  const other = await f.send('other', 'GET', '/v1/libraryLabels?limit=100');
  expect(other.status).toBe(200);
  expect((await other.json()).labels).not.toContainEqual(expect.objectContaining({ id }));
  const renamed = await f.send('owner', 'PATCH', path, { name: 'Changed', revision });
  expect(renamed.status).toBe(200);
  expect((await renamed.json()).label).toEqual({ id, revision: revision + 1 });
  const forged = await f.send('owner', 'PATCH', path, { name: 'x', revision: String(revision + 1) });
  expect(forged.status).toBe(400);
  const extra = await f.send('owner', 'POST', '/v1/libraryLabels', { name: 'x', profileId: 'forged' });
  expect(extra.status).toBe(400);
  const foreign = await f.send('other', 'PATCH', path, { name: 'foreign', revision: revision + 1 });
  const unknown = await f.send('other', 'PATCH', '/v1/libraryLabels/' + f.unknownSubject(), {
    name: 'foreign',
    revision: revision + 1,
  });
  expect(foreign.status).toBe(404);
  expect(unknown.status).toBe(404);
  const clean = (value: Record<string, unknown>) => {
    const { request_id, ...rest } = value;
    return rest;
  };
  expect(clean(await foreign.json())).toEqual(clean(await unknown.json()));
  const deleteKey = entryKey();
  const removed = await f.send('owner', 'DELETE', path + '?revision=' + (revision + 1), undefined, deleteKey);
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ deleted: true });
  expect(removed.headers.get('Library-Label-Revision')).toBe(String(revision + 2));
  const replay = await f.send('owner', 'POST', '/v1/libraryLabels', { name: '  HTTP   label ' }, key);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(first);
  const restored = await f.send('owner', 'POST', path + ':restore', { revision: revision + 2 });
  expect(restored.status).toBe(200);
  expect((await restored.json()).label).toEqual({ id, revision: revision + 3 });
  const deletedReplay = await f.send('owner', 'DELETE', path + '?revision=' + (revision + 1), undefined, deleteKey);
  expect(deletedReplay.status).toBe(200);
  expect(await deletedReplay.json()).toEqual({ deleted: true });
  expect(deletedReplay.headers.get('Library-Label-Revision')).toBe(String(revision + 2));
  const anon = await f.send('anonymous', 'GET', '/v1/libraryLabels');
  expect([401, 403]).toContain(anon.status);
  const replayKey = entryKey();
  expect((await f.send('owner', 'POST', '/v1/libraryLabels', { name: 'suspend receipt' }, replayKey)).status).toBe(201);
  await f.suspend(f.owner.actor.accountId);
  const denied = await f.send('owner', 'POST', '/v1/libraryLabels', { name: 'suspend receipt' }, replayKey);
  expect([401, 403]).toContain(denied.status);
  expect(await denied.text()).not.toContain('"label"');
}, 120000);
