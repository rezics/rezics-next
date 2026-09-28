import { defineZonePackage } from '@rezics/zone-sdk';
import css from './mods.css?raw';
import { ModsCard, ModsCollections, ModsFilters, ModsFooter, ModsHeader, ModsHero, ModsShelf, ModsTrending }
  from './slots.tsx';

/**
 * The official Mods Zone (`/r/mods`), a game-mod hub in the spirit of
 * Modrinth and Nexus Mods: games and loaders up front as a filter bar, a
 * trending board, and download-first cards everywhere, on a dark block grid.
 */
export default defineZonePackage({
  slug: 'mods',
  css,
  slots: { header: ModsHeader, hero: ModsHero, footer: ModsFooter, workCard: ModsCard,
    modules: { 'chip-nav': ModsFilters, ranking: ModsTrending, shelf: ModsShelf, 'editorial-list': ModsCollections } },
});
