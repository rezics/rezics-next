import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('the sitemap can disclose a saved dynamic Collection backed by an explicitly completed empty selection', async () => {
  const created = await f.send('POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'An explicit empty selection',
    visibility: 'private',
    rule: { filter: { owner: { presence: true } } },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const published = await f.send('POST', `/v1/collections/${collection.id}:publishSelected`, {
    revision: collection.revision,
    subjectIds: [],
  });
  expect(published.status).toBe(200);
  const members = await f.send('GET', `/v1/collections/${collection.id}/members`, undefined, null);
  expect(members.status).toBe(200);
  expect(await members.json()).toEqual({ members: [], next: null });
  let cursor: string | null = null;
  const found: { id: string; lastModified: string }[] = [];
  do {
    const response = await f.send(
      'GET',
      `/v1/sitemap/collections?limit=1000${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      undefined,
      null,
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    found.push(...page.items.filter((item: { id: string }) => item.id === collection.id));
    cursor = page.next;
  } while (cursor !== null);
  expect(found).toEqual([{ id: collection.id, lastModified: expect.any(String) }]);
  expect(Number.isFinite(Date.parse(found[0]!.lastModified))).toBe(true);
}, 120_000);
