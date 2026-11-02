import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createCollectionKindFixture, type CollectionKindFixture } from './support/collection-kind-fixture.ts';

let f: CollectionKindFixture;
beforeAll(async () => {
  f = await createCollectionKindFixture();
}, 120_000);
beforeEach(async () => {
  await f.refresh();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('unset Collection kind is mixed immediately for owner, other and anonymous', async () => {
  const collection = await f.collection({ visibility: 'public' });
  expect(await f.read(collection.id)).toMatchObject({ presentationKind: null, presentationKindSource: 'mixed' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  for (const bearer of [f.owner.bearer, f.other.bearer, null]) {
    expect(await f.read(collection.id, bearer)).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
      memberCount: 1,
    });
    const listed = await f.send(bearer, 'GET', `/v1/collections?curatorAccountId=${f.owner.accountId}`);
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { collections: { id: string }[] }).collections;
    expect(rows.find(({ id }) => id === collection.id)).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
    });
  }
}, 120_000);

test('mixed presentation preserves duplicate occurrences and private Collection authorization', async () => {
  const collection = await f.collection();
  const movie = await f.subject('schema:Movie');
  const book = await f.subject('schema:Book');
  // Neither repeated subjects nor different member Types select a Collection kind.
  for (let n = 0; n < 5; n++) await f.add(collection.id, movie);
  await f.add(collection.id, book);
  expect(await f.read(collection.id)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
    memberCount: 6,
  });
  expect((await f.send(f.other.bearer, 'GET', f.path(collection.id))).status).toBe(404);
  expect((await f.send(null, 'GET', f.path(collection.id))).status).toBe(404);
}, 120_000);

test('mixed presentation reveals no hidden Type or Type count', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const hidden = await f.subject('schema:Movie');
  for (let n = 0; n < 8; n++) await f.add(collection.id, hidden);
  await f.hide(hidden);
  await f.add(collection.id, await f.subject('schema:Book'));
  for (const bearer of [f.owner.bearer, f.other.bearer, null]) {
    const row = await f.read(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: null, presentationKindSource: 'mixed' });
    expect(row).not.toHaveProperty('typeCounts');
  }
}, 120_000);

test('owner override wins and null clear restores mixed presentation without changing member Types', async () => {
  const collection = await f.collection({ presentationKind: 'schema:Movie' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  expect(await f.read(collection.id)).toMatchObject({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'owner',
  });
  await f.patch(collection.id, null);
  expect(await f.read(collection.id)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
  });
  const response = await f.send(f.owner.bearer, 'GET', `/v1/subjects/${book}`);
  expect(response.status).toBe(200);
  expect((await response.json()).subject.type).toBe('schema:Book');
}, 120_000);

test('mixed presentation does not derive a kind from deep members', async () => {
  const collection = await f.collection();
  for (let n = 0; n < 3; n++) await f.add(collection.id, await f.subject('schema:Movie'));
  for (let n = 0; n < 101; n++) await f.add(collection.id, await f.subject('schema:Book'));
  expect(await f.read(collection.id)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
    memberCount: 104,
  });
}, 240_000);

test('hidden members do not change mixed presentation or reveal their Types', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  expect(await f.read(collection.id, null)).toMatchObject({ presentationKind: null });
  await f.hide(book);
  const immediate = await f.read(collection.id, null);
  expect(immediate.presentationKind).toBeNull();
  expect(immediate.presentationKindSource).toBe('mixed');
  expect(await f.read(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
    memberCount: 1,
  });
}, 120_000);
