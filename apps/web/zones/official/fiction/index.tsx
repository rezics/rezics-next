import { defineZonePackage } from '@rezics/zone-sdk';
import css from './fiction.css?raw';
import {
  FictionFooter,
  FictionHeader,
  FictionHero,
  FictionRanking,
  FictionShelf,
  FictionWorkCard,
} from './slots.tsx';

/**
 * The official Fiction Zone (`/z/fiction`): the first official package. It
 * presents cover shelves, chapter updates and measured rankings through the
 * platform's named slots and shared Work covers.
 */
export default defineZonePackage({
  slug: 'fiction',
  css,
  slots: {
    header: FictionHeader,
    hero: FictionHero,
    workCard: FictionWorkCard,
    footer: FictionFooter,
    modules: { ranking: FictionRanking, shelf: FictionShelf },
  },
});
