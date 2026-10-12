import { restoreBrowserRecipes } from '../../../scripts/load/launch-corpus.ts';

// Restore retained owner stores before the browser applications start.
export const restoreStack = restoreBrowserRecipes;
export const preparation = {
  command: ['bun', 'scripts/load/launch-corpus.ts', '--browser-recipes-prepare'],
  budgetMs: 600_000,
  step: 'Real recipes preparation',
  slug: 'launch-recipes-restore',
};
