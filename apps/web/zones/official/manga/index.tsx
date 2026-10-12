import { defineZonePackage } from '@rezics/zone-sdk';
import { MangaBrowseHeader, MangaCard, MangaCataloguePanel, MangaFooter } from './slots.tsx';
import css from './manga.css?raw';

/** Public names of the manga formats, in every interface language the scheme records. */
export const mangaFormatNames = [
  'Manga', '漫畫', '漫画', '만화',
  'One-shot', '單篇', '单篇', '読切', '단편',
] as const;

/**
 * The official Manga Zone (`/z/manga`): browse by format and status, and by publication year,
 * newest first. A card and the work page state the recorded format, year, volume count and status.
 */
export default defineZonePackage({
  slug: 'manga',
  css,
  catalogue: { count: 'volumes', formatNames: mangaFormatNames },
  slots: {
    browseHeader: MangaBrowseHeader,
    workCard: MangaCard,
    cataloguePanel: MangaCataloguePanel,
    footer: MangaFooter,
  },
});
