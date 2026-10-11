// Seed the pinned recipe Works into the isolated browser stack before Playwright starts.
export const preparation = {
  command: ['bun', 'scripts/load/launch-corpus.ts', '--browser-recipes-prepare'],
  budgetMs: 600_000,
  step: 'Real recipes preparation',
  slug: 'launch-recipes-seed',
};
