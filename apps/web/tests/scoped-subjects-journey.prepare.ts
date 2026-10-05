// The e2e harness reads this sibling of scoped-subjects-journey.e2e.ts and runs the command once,
// before Playwright, when that journey or the whole browser tier is selected. The module only
// declares the command: importing the seed would run it at discovery time.
export const preparation = {
  command: ['bun', 'apps/web/tests/scoped-subjects-journey-seed.ts'],
  budgetMs: 600_000,
  step: 'Scoped subjects preparation',
  slug: 'scoped-subjects-seed',
};
