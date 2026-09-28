import { defineZonePackage } from '@rezics/zone-sdk';
import css from './games.css?raw';
import { GamesCard, GamesHero, GamesLists, GamesShelf } from './slots.tsx';

/** Media-first games discovery using the host's public cards and Decision links. */
export default defineZonePackage({ slug: 'games', css,
  slots: { hero: GamesHero, workCard: GamesCard,
    modules: { shelf: GamesShelf, 'editorial-list': GamesLists } } });
