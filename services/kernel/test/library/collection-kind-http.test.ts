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

test('automatic Collection kind converges to the complete current visible member Type for owner, other and anonymous', async () => {
  const collection = await f.collection({ visibility: 'public' });
  expect(await f.read(collection.id)).toMatchObject({ presentationKind: null, presentationKindSource: 'empty' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  for (const bearer of [f.owner.bearer, f.other.bearer, null]) {
    expect(await f.complete(collection.id, bearer)).toMatchObject({
      presentationKind: 'schema:Book',
      presentationKindSource: 'members',
      memberCount: 1,
    });
    const listed = await f.send(bearer, 'GET', `/v1/collections?curatorAccountId=${f.owner.accountId}`);
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { collections: { id: string }[] }).collections;
    expect(rows.find(({ id }) => id === collection.id)).toMatchObject({
      presentationKind: 'schema:Book',
      presentationKindSource: 'members',
    });
  }
}, 120_000);

test('mixed Type ties use exact TypeId order and duplicate curated occurrences never add votes', async () => {
  const collection = await f.collection();
  const movie = await f.subject('schema:Movie');
  const book = await f.subject('schema:Book');
  // Occurrence order and frequency both favour Movie; two canonical subjects still tie.
  for (let n = 0; n < 5; n++) await f.add(collection.id, movie);
  await f.add(collection.id, book);
  expect(await f.complete(collection.id)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
    memberCount: 6,
  });
  expect((await f.send(f.other.bearer, 'GET', f.path(collection.id))).status).toBe(404);
  expect((await f.send(null, 'GET', f.path(collection.id))).status).toBe(404);
}, 120_000);

test('hidden first and frequent Types cannot supply a winner or a Type count oracle', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const hidden = await f.subject('schema:Movie');
  for (let n = 0; n < 8; n++) await f.add(collection.id, hidden);
  await f.hide(hidden);
  await f.add(collection.id, await f.subject('schema:Book'));
  for (const bearer of [f.owner.bearer, f.other.bearer, null]) {
    const row = await f.complete(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: 'schema:Book', presentationKindSource: 'members' });
    expect(row).not.toHaveProperty('typeCounts');
  }
}, 120_000);

test('owner override wins and null clear resumes complete derivation without changing member Types', async () => {
  const collection = await f.collection({ presentationKind: 'schema:Movie' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  expect(await f.read(collection.id)).toMatchObject({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'owner',
  });
  await f.patch(collection.id, null);
  expect(await f.complete(collection.id)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  const response = await f.send(f.owner.bearer, 'GET', `/v1/subjects/${book}`);
  expect(response.status).toBe(200);
  expect((await response.json()).subject.type).toBe('schema:Book');
}, 120_000);

test('complete derivation reaches deep members rather than preview or first-page sampling', async () => {
  const collection = await f.collection();
  for (let n = 0; n < 3; n++) await f.add(collection.id, await f.subject('schema:Movie'));
  for (let n = 0; n < 101; n++) await f.add(collection.id, await f.subject('schema:Book'));
  expect(await f.complete(collection.id)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
    memberCount: 104,
  });
}, 240_000);

test('revoking the last visible original invalidates the old winner and proves eligible empty', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  expect(await f.complete(collection.id, null)).toMatchObject({ presentationKind: 'schema:Book' });
  await f.hide(book);
  const immediate = await f.read(collection.id, null);
  expect(immediate.presentationKind).toBeNull();
  expect(['empty', 'pending']).toContain(immediate.presentationKindSource);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
    memberCount: 1,
  });
}, 120_000);
