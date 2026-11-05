import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update']);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('one native list request exposes an explicit bounded preview field for a real empty Collection', async () => {
  const made = await f.send(
    owner.bearer,
    'POST',
    '/v1/collections',
    { title: 'Preview source', visibility: 'private' },
    entryKey(),
  );
  expect(made.status).toBe(201);
  const c = (await made.json()).collection;
  const r = await f.send(
    owner.bearer,
    'GET',
    `/v1/collections?curatorAccountId=${owner.actor.accountId}&view=FULL&preview=3&limit=20`,
  );
  expect(r.status).toBe(200);
  const row = (await r.json()).collections.find((x: { id: string }) => x.id === c.id);
  expect(row.previewStatus).toBe('ready');
  expect(row.previewMembers).toEqual([]);
}, 120000);
