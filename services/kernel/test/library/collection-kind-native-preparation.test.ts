import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { collectionKindInputWork } from '../../src/library/collection-kind-input-bounds.ts';
import { readCollectionKindPreparationType } from '../../src/library/collection-kind-preparation.ts';
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

test('mixed presentation is independent of member changes and hidden Types', async () => {
  const collection = await f.collection({ visibility: 'public' });
  expect(await f.read(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
  });
  const book = await f.subject('schema:Book');
  await f.add(collection.id, book);
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    expect(await f.read(collection.id, bearer)).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
    });
  }
  await f.hide(book);
  const current = await f.read(collection.id, null);
  expect(current).toMatchObject({ presentationKind: null, presentationKindSource: 'mixed', memberCount: 1 });
  expect(current).not.toHaveProperty('typeCounts');
}, 120_000);

test('an explicit kind supplies presentation for every readable viewer', async () => {
  const collection = await f.collection({ visibility: 'public', presentationKind: 'schema:Movie' });
  await f.add(collection.id, await f.subject('schema:Book'));
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    expect(await f.read(collection.id, bearer)).toMatchObject({
      presentationKind: 'schema:Movie',
      presentationKindSource: 'owner',
    });
  }
}, 120_000);

test('native Type evidence stays unavailable and is not treated as an empty match', async () => {
  const remaining = collectionKindInputWork();
  const result = await readCollectionKindPreparationType({
    allowance: { reservationId: crypto.randomUUID(), remaining },
    deadline: Date.now() + 5000,
  });
  expect(result.status).toBe('unavailable');
  expect(result).not.toHaveProperty('typeId');
  expect(Object.values(result.work.used).every((value) => value === 0)).toBe(true);
  const collection = await f.collection({ visibility: 'public' });
  expect(await f.read(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'mixed',
  });
}, 120_000);
