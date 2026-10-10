// The e2e harness reads this sibling of partless-progress.e2e.ts and runs the seed once, before Playwright.
export const preparation = {
  command: ['bun', 'apps/web/tests/partless-progress-seed.ts'],
  budgetMs: 180_000,
  step: 'Partless progress preparation',
  slug: 'partless-progress-seed',
};
