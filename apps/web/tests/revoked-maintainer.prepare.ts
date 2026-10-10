// The e2e harness reads this sibling of revoked-maintainer.e2e.ts and runs the command once,
// before Playwright, when that journey is selected. Importing the seed would run it at discovery time.
export const preparation = {
  command: ['bun', 'apps/web/tests/revoked-maintainer-seed.ts'],
  budgetMs: 300_000,
  step: 'Revoked maintainer preparation',
  slug: 'revoked-maintainer-seed',
};
