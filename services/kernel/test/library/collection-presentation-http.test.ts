import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity([
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
  ]);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('curator persists and clears an actual TypeId presentation override with native metadata CAS', async () => {
  const type = Object.keys(bundledRelease.types).sort()[0]!;
  const made = await f.send(
    owner.bearer,
    'POST',
    '/v1/collections',
    { title: 'Typed collection', visibility: 'private', presentationKind: type, coverMediaId: null },
    entryKey(),
  );
  expect(made.status).toBe(201);
  const value = (await made.json()).collection;
  expect(value.presentationKind).toBe(type);
  expect(value.presentationKindSource).toBe('owner');
  const path = `/v1/collections/${value.id}`;
  const read = await f.send(owner.bearer, 'GET', path);
  expect(read.status).toBe(200);
  expect((await read.json()).collection).toMatchObject({
    id: value.id,
    presentationKind: type,
    presentationKindSource: 'owner',
    memberCount: 0,
  });
  const cleared = await f.send(
    owner.bearer,
    'PATCH',
    path,
    { revision: value.revision, presentationKind: null, coverMediaId: null },
    entryKey(),
  );
  expect(cleared.status).toBe(200);
  const next = (await cleared.json()).collection;
  expect(next.revision).toBeGreaterThan(value.revision);
  expect(next.presentationKind).toBeNull();
  expect(next.presentationKindSource).toBe('mixed');
  expect((await f.send('anonymous', 'GET', path)).status).toBe(404);
}, 120000);
