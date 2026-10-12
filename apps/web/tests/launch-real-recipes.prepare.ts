// The runner loads storage tooling; this browser declaration carries only its location.
export const restoreStack = {
  module: 'scripts/load/launch-corpus.ts',
  exportName: 'restoreBrowserRecipes',
};
export const preparation = {
  command: ['bun', 'scripts/load/launch-corpus.ts', '--browser-recipes-prepare'],
  budgetMs: 600_000,
  step: 'Real recipes preparation',
  slug: 'launch-recipes-restore',
};
