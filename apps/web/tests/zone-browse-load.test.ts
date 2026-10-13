import { expect, test } from 'bun:test';
import './support/official-package-fixture.ts';

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
