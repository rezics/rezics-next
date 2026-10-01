import { defineZonePackage } from '@rezics/zone-sdk';
import css from './light-novels.css?raw';
import { LightNovelCard, LightNovelFooter, LightNovelIndex, LightNovelShelf } from './slots.tsx';

/**
 * The official Light Novels Zone (`/r/light-novels`): series and their volumes over the shared catalogue.
 * A signed-in reader sees the next volume in the language they chose, as Main reports it, on the cards,
 * on a "Continue your series" shelf, and a series' page leads with its parts and progress. It states what
 * it does not cover and links to the Visual Novels Zone over the same Works.
 */
export default defineZonePackage({
  slug: 'light-novels',
  css,
  // A series' page leads with its parts and the reader's next one.
  hubOrder: ['parts'],
  slots: { index: LightNovelIndex, workCard: LightNovelCard, footer: LightNovelFooter,
    modules: { shelf: LightNovelShelf } },
});
