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

test('Automatic Collection kind uses actual native complete audience preparation instead of permanent unavailable select prepare resume and revalidation adapters', async () => {
  const collection = await f.collection({ visibility: 'public' });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  const first = await f.read(collection.id, null);
  if (first.presentationKindSource === 'pending') expect(first.presentationKind).toBeNull();
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  // A current authenticated reader goes through its own verified native audience admission.
  expect(await f.complete(collection.id, f.other.bearer)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  await f.hide(book);
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    const current = await f.read(collection.id, bearer);
    expect(current.presentationKind).toBeNull();
    expect(['pending', 'empty']).toContain(current.presentationKindSource);
    expect(current).not.toHaveProperty('typeCounts');
  }
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
    memberCount: 1,
  });
}, 120_000);

test('default kind observation is invalidated by actual source mutation and empty requires completion', async () => {
  const collection = await f.collection({ visibility: 'public' });
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  await f.add(collection.id, await f.subject('schema:Movie'));
  const changed = await f.read(collection.id, null);
  expect(changed.presentationKindSource).not.toBe('empty');
  if (changed.presentationKindSource === 'pending') expect(changed.presentationKind).toBeNull();
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'members',
  });
}, 120_000);

test('default preparation readiness never delays or replaces an owner override', async () => {
  const collection = await f.collection({ visibility: 'public', presentationKind: 'schema:Movie' });
  await f.add(collection.id, await f.subject('schema:Book'));
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    expect(await f.read(collection.id, bearer)).toMatchObject({
      presentationKind: 'schema:Movie',
      presentationKindSource: 'owner',
    });
  }
}, 120_000);
