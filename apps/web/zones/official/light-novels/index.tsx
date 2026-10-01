import { defineZonePackage } from '@rezics/zone-sdk';
import css from './light-novels.css?raw';
import { LightNovelCard, LightNovelDetail, LightNovelFooter, LightNovelIndex, LightNovelShelf } from './slots.tsx';

/**
 * The official Light Novels Zone (`/r/light-novels`): series and their volumes over the shared catalogue.
 * A signed-in reader sees the next volume in the language they chose, as Main reports it, on the cards,
 * on a "Continue your series" shelf and with the series progress panel on a series' page. It states what
 * it does not cover and links to the Visual Novels Zone over the same Works.
 */
export default defineZonePackage({
  slug: 'light-novels',
  css,
  slots: { index: LightNovelIndex, workCard: LightNovelCard, workDetail: LightNovelDetail, footer: LightNovelFooter,
    modules: { shelf: LightNovelShelf } },
});
