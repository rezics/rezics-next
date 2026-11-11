import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

test('rejects malformed trees and cross-route selectors at HTTP boundaries and enforces Post revise authority', async () => {
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const left = f.newOccurrenceId();
  const right = f.newOccurrenceId();
  const cyclic = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: [
      { occurrenceId: left, parentId: right, position: 0, title: 'Left', kind: 'part' },
      { occurrenceId: right, parentId: left, position: 0, title: 'Right', kind: 'part' },
    ],
  });
  expect(cyclic.status).toBe(400);

  const foreignRoute = ((routeOf(f.catalogueId) ?? 0) + 1) % 65_536;
  const invalidSelector = await f.native.call('GET', `${path}?revisionId=${newId(foreignRoute)}`);
  expect(invalidSelector.status).toBe(400);

  const empty = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: f.catalogueId,
    threadId: f.threadId,
    placements: [],
  });
  expect(empty.status).toBe(201);
  const denied = await f.native.call(
    'POST',
    `${path}:revise`,
    {
      expectedRevisionId: empty.value.revisionId,
      placements: [],
    },
    { other: true },
  );
  expect(denied.status).toBe(403);
});
