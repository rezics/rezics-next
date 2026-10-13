import { expect, mock, test } from 'bun:test';

// The route module loads official packages through Vite's glob. This runner has no glob, so the
// package table is replaced before the route is imported. The count is the route's own loader.
await mock.module('../zones/official/index.ts', () => ({
  installedDigest: async () => null,
  loadPackage: async () => null,
}));

test('a Zone browse page loads its view once', async () => {
  const { RealmBrowseRoute } = await import('../features/realm/routes.tsx');
  let loads = 0;
  try {
    await RealmBrowseRoute({
      params: Promise.resolve({ locale: 'en', realm: 'anime' }),
      searchParams: Promise.resolve({}),
    }, async () => {
      loads += 1;
      return { kind: 'missing' };
    });
  } catch {
    // A missing Realm is notFound(). The load still happened once, before that answer.
  }
  expect(loads).toBe(1);
});
