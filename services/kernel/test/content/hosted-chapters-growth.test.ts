import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(600_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('a maximum-size release pages raw protected slots without refill or cursor drift', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const protectedTarget = await f.protectedChapter();
  const ids = Array.from({ length: 512 }, () => f.newOccurrenceId());
  const placements = ids.map((occurrenceId, position) =>
    position < 22
      ? {
          occurrenceId,
          parentId: null,
          position,
          title: `Protected ${position}`,
          kind: 'chapter',
          target: protectedTarget,
        }
      : { occurrenceId, parentId: null, position, title: `Part ${position}`, kind: 'part' },
  );
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements,
  });
  expect(created.status).toBe(201);
  const published = await f.native.call('POST', `${path}:publish`, {
    expectedRevisionId: created.value.revisionId,
    expectedPublicationId: null,
    occurrenceIds: ids,
  });
  expect(published.status).toBe(200);

  const first = await f.native.call('GET', `${path}/children?limit=2`, undefined, { anonymous: true });
  expect(first.value.items).toMatchObject([
    { occurrenceId: ids[0], position: 0, availability: 'unavailable' },
    { occurrenceId: ids[1], position: 1, availability: 'unavailable' },
  ]);
  expect(first.value.nextCursor).toEqual(expect.any(String));
  expect(first.value.items).toHaveLength(2);

  const second = await f.native.call(
    'GET',
    `${path}/children?limit=2&cursor=${encodeURIComponent(first.value.nextCursor)}`,
    undefined,
    { anonymous: true },
  );
  expect(second.value.items).toMatchObject([
    { occurrenceId: ids[2], position: 2, availability: 'unavailable' },
    { occurrenceId: ids[3], position: 3, availability: 'unavailable' },
  ]);
  expect(second.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).not.toContain(ids[1]);
});
