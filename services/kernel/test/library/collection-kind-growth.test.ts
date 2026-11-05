import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { createCollectionKindFixture, type CollectionKindFixture } from './support/collection-kind-fixture.ts';

let f: CollectionKindFixture;
beforeAll(async () => {
  f = await createCollectionKindFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('mixed kind reads stay bounded with native64/512/4096 changed and unrelated members', async () => {
  const selected = await f.collection({ visibility: 'public' });
  const unrelated = await f.collection();
  const duplicate = await f.subject('schema:Movie');
  await f.add(selected.id, await f.subject('schema:Book'));
  await checkGrowth(f.database, {
    name: 'mixed Collection kind with native source growth',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    async grow(_db, scale, previous) {
      await f.refresh();
      for (let n = previous; n < scale; n++) {
        const book = await f.subject('schema:Book');
        await f.add(selected.id, book);
        await f.add(selected.id, duplicate);
        await f.add(unrelated.id, book);
      }
      // Presentation is immediate regardless of member population.
      expect(await f.read(selected.id)).toMatchObject({
        presentationKind: null,
        presentationKindSource: 'mixed',
      });
    },
    async operation() {
      for (const bearer of [f.owner.bearer, f.other.bearer, null]) {
        expect(await f.read(selected.id, bearer)).toMatchObject({
          presentationKind: null,
          presentationKindSource: 'mixed',
        });
      }
    },
  });
}, 900_000);
