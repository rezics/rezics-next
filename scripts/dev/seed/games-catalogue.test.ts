import { expect, test } from 'bun:test';
import { gamesCatalogue } from './games-catalogue.ts';
import { extraWorks, zoneContent } from './official-plan.ts';

test('Games has twelve typed public Works, released and upcoming shelves, and mod paths', () => {
  expect(gamesCatalogue).toHaveLength(12);
  expect(new Set(gamesCatalogue.map(game => game.id)).size).toBe(12);
  expect(gamesCatalogue.some(game => game.status === 'upcoming')).toBe(true);
  expect(gamesCatalogue.some(game => game.status === 'released')).toBe(true);
  expect(gamesCatalogue.filter(game => game.mods).length).toBeGreaterThanOrEqual(2);
  for (const game of gamesCatalogue) {
    expect(game.source).toMatch(/^https:\/\/(?:store\.steampowered\.com\/app\/\d+\/|www\.minecraft\.net\/)/);
    expect(game.tags.length).toBeGreaterThan(0);
    expect(extraWorks.find(work => work.id === game.id)).toMatchObject({ realm: 'games', type: 'game' });
    expect(zoneContent.games.adopt).toContain(game.id);
  }
  const upcoming = zoneContent.games.lists.find(list => list.id === 'upcoming')!;
  expect(upcoming.works.every(id => gamesCatalogue.find(game => game.id === id)?.status === 'upcoming')).toBe(true);
});
