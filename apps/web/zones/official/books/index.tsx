import { defineZonePackage } from '@rezics/zone-sdk';
import css from './books.css?raw';
import { BooksColumns, BooksFooter, BooksHeader, BooksHero, BooksRanking, BooksShelf, BooksSpotlight,
  BooksWorkCard } from './slots.tsx';

/**
 * The official Books Zone (`/r/books`): a cover-first library with new
 * arrivals, curated shelves and measured reader charts in named platform slots.
 */
export default defineZonePackage({
  slug: 'books',
  css,
  slots: { header: BooksHeader, hero: BooksHero, workCard: BooksWorkCard, footer: BooksFooter,
    modules: { shelf: BooksShelf, ranking: BooksRanking, 'editorial-list': BooksColumns,
      people: BooksSpotlight } },
});
