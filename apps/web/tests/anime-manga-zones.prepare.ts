// The e2e harness reads this sibling of anime-manga-zones.e2e.ts and runs the command once, before Playwright,
// when that journey or the whole browser tier is selected.
export const preparation = {
  command: ['bun', 'apps/web/tests/anime-manga-zones-seed.ts'],
  budgetMs: 600_000,
  step: 'Anime and manga Zone preparation',
  slug: 'anime-manga-zones-seed',
};
