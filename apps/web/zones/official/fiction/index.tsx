import { defineZonePackage } from '@rezics/zone-sdk';
import css from './fiction.css?raw';
import { FictionFooter, FictionHeader, FictionHero, FictionRanking } from './slots.tsx';

/**
 * The official Fiction Zone (`/r/fiction`): the first official package. It
 * enhances the Zone's token-and-layout presentation with a masthead, a hero
 * band, a chart-style ranking and a footer; every other module and every
 * card stays the platform's.
 */
export default defineZonePackage({
  slug: 'fiction',
  css,
  slots: { header: FictionHeader, hero: FictionHero, footer: FictionFooter, modules: { ranking: FictionRanking } },
});
