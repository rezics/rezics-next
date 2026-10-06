// The e2e harness reads this sibling of showcase-acceptance.e2e.ts and runs the command once, before Playwright,
// when that journey or the whole browser tier is selected.
export const preparation = {
  command: ['bun', 'apps/web/tests/showcase-acceptance-seed.ts'],
  budgetMs: 300_000,
  step: 'Showcase acceptance preparation',
  slug: 'showcase-acceptance-seed',
};
