import { defineZonePackage } from '@rezics/zone-sdk';
import { AnimeBrowseHeader, AnimeCard, AnimeCataloguePanel, AnimeFooter } from './slots.tsx';
import css from './anime.css?raw';

/** Public names of the anime formats, in every interface language the scheme records. */
export const animeFormatNames = [
  'TV', '電視', '电视', 'テレビ',
  'Movie', '劇場版', '剧场版', '극장판', 'Film', 'Película',
  'OVA', 'ONA',
  'Special', '特別篇', '特别篇', 'スペシャル', '스페셜', 'Spécial', 'Especial',
] as const;

/**
 * The official Anime Zone (`/z/anime`): browse by format and status, and by publication year,
 * using the shared browse sort. Cards and work pages state recorded format, year, episode count and status.
 */
export default defineZonePackage({
  slug: 'anime',
  css,
  catalogue: { count: 'episodes', formatNames: animeFormatNames },
  slots: {
    browseHeader: AnimeBrowseHeader,
    workCard: AnimeCard,
    cataloguePanel: AnimeCataloguePanel,
    footer: AnimeFooter,
  },
});
