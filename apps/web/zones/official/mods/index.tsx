import { defineZonePackage } from '@rezics/zone-sdk';
import css from './mods.css?raw';
import { ModsCard, ModsCollections, ModsHero, ModsShelf, ModsTrending } from './slots.tsx';

/**
 * The official Mods Zone (`/z/mods`), laid out as Modrinth lists mods: the
 * platform's search and filters first, then every pick as a result row with
 * its icon, summary, what it runs on and when it last changed. It keeps
 * REZICS's colours, type and header.
 */
export default defineZonePackage({
  slug: 'mods',
  css,
  slots: {
    hero: ModsHero,
    workCard: ModsCard,
    modules: { ranking: ModsTrending, shelf: ModsShelf, 'editorial-list': ModsCollections },
  },
});
