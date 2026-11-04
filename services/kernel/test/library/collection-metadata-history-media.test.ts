import { afterAll, beforeAll, expect, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import {
  createCollectionPresentationFixture,
  type CollectionPresentationFixture,
} from './support/collection-presentation-fixture.ts';

let f: CollectionPresentationFixture;
beforeAll(async () => {
  f = await createCollectionPresentationFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

test('historical covers are withheld after the current Media record is erased', async () => {
  const cover = await f.importedCover();
  const collection = await f.collection();
  const selected = await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, {
    revision: collection.revision,
    coverMediaId: cover.mediaId,
  });
  expect(selected.status).toBe(200);
  const withCover = ((await selected.json()) as { collection: { revision: number } }).collection;
  const cleared = await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, {
    revision: withCover.revision,
    coverMediaId: null,
  });
  expect(cleared.status).toBe(200);
  const erased = await f.database.admin.query(
    'UPDATE content.media SET erased=true,security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [routeOf(cover.mediaId), cover.mediaId],
  );
  expect(erased.rowCount).toBe(1);
  const history = await f.send(
    f.owner.bearer,
    'GET',
    `/v1/collections/${collection.id}/metadata-history/${withCover.revision + 1}`,
  );
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({
    revision: withCover.revision + 1,
    before: { cover: { state: 'unavailable' } },
    after: { cover: { state: 'none' } },
    actions: { review: true, reapply: false },
  });
}, 120_000);
