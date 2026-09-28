import { defineZonePackage } from '@rezics/zone-sdk';
import css from './ai-workshop.css?raw';
import { WorkshopCard, WorkshopCollections, WorkshopFooter, WorkshopHeader, WorkshopHero, WorkshopShelf }
  from './slots.tsx';

/**
 * The official AI Workshop Zone (`/r/ai-workshop`), a gallery of prompts and
 * skills: copy-first cards with a "Try it" beside every pick, shelves as a
 * gallery, editors' lists as collections by task, on a quiet dot grid.
 */
export default defineZonePackage({
  slug: 'ai-workshop',
  css,
  slots: { header: WorkshopHeader, hero: WorkshopHero, footer: WorkshopFooter, workCard: WorkshopCard,
    modules: { shelf: WorkshopShelf, 'editorial-list': WorkshopCollections } },
});
