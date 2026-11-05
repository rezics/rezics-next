import { routeOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
test('selected duplicate occurrence moves across same-curator Collections with its native identity and note intact', async () => {
  const make = async (title: string) => {
    const r = await f.send(owner.bearer, 'POST', '/v1/collections', { title, visibility: 'private' }, entryKey());
    expect(r.status).toBe(201);
    return (await r.json()).collection;
  };
  const source = await make('Source'),
    destination = await make('Destination');
  const subjectId = await f.createSubject('game');
  const add = async (note: string) => {
    const r = await f.send(
      owner.bearer,
      'POST',
      `/v1/collections/${source.id}/members`,
      { subjectId, note },
      entryKey(),
    );
    expect(r.status).toBe(201);
    return (await r.json()).member;
  };
  const first = await add('move exact occurrence'),
    sibling = await add('leave duplicate');
  const read = await f.send(owner.bearer, 'GET', `/v1/collections/${source.id}`);
  expect(read.status).toBe(200);
  const revision = (await read.json()).collection.revision;
  const moved = await f.send(
    owner.bearer,
    'POST',
    `/v1/collections/${source.id}/members:move`,
    {
      revision,
      memberIds: [first.id],
      destinationCollectionId: destination.id,
      destinationRevision: destination.revision,
      after: null,
    },
    entryKey(),
  );
  expect(moved.status).toBe(200);
  const result = await moved.json();
  expect(result.members[0]).toMatchObject({ id: first.id, subjectId, note: first.note, addedAt: first.addedAt });
  const from = await f.send(owner.bearer, 'GET', `/v1/collections/${source.id}/members`),
    to = await f.send(owner.bearer, 'GET', `/v1/collections/${destination.id}/members`);
  expect(from.status).toBe(200);
  expect(to.status).toBe(200);
  expect((await from.json()).members.map((m: { id: string }) => m.id)).toEqual([sibling.id]);
  expect((await to.json()).members.map((m: { id: string }) => m.id)).toEqual([first.id]);
}, 120000);

// A routed transfer never degrades to independent copy/remove commands.
test('cross-curator move reports unsupported without changing the selected source occurrence', async () => {
  const make = async (bearer: string) => {
    const response = await f.send(
      bearer,
      'POST',
      '/v1/collections',
      { title: 'Move target', visibility: 'private' },
      entryKey(),
    );
    expect(response.status).toBe(201);
    return (await response.json()).collection;
  };
  const source = await make(owner.bearer);
  let other = await f.identity(['collection:create']);
  while (routeOf(other.actor.accountId) === routeOf(source.id)) other = await f.identity(['collection:create']);
  const destination = await make(other.bearer);
  const subjectId = await f.createSubject('game');
  const added = await f.send(
    owner.bearer,
    'POST',
    `/v1/collections/${source.id}/members`,
    { subjectId, note: 'Retain me' },
    entryKey(),
  );
  expect(added.status).toBe(201);
  const member = (await added.json()).member;
  const response = await f.send(
    owner.bearer,
    'POST',
    `/v1/collections/${source.id}/members:move`,
    {
      revision: source.revision + 1,
      memberIds: [member.id],
      destinationCollectionId: destination.id,
      destinationRevision: destination.revision,
      after: null,
    },
    entryKey(),
  );
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('collection_move_unsupported');
  const remaining = await f.send(owner.bearer, 'GET', `/v1/collections/${source.id}/members`);
  expect((await remaining.json()).members).toEqual([member]);
}, 120000);
