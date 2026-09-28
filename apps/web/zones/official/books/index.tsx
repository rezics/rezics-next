import { defineZonePackage } from '@rezics/zone-sdk';
import css from './books.css?raw';
import { BooksColumns, BooksFooter, BooksHeader, BooksHero, BooksShelf, BooksSpotlight } from './slots.tsx';

/**
 * The official Books Zone (`/r/books`), set as a literary magazine: a
 * nameplate, a cover story with the issue's contents, shelves that page like
 * Goodreads' "Readers also enjoyed", editors' lists as columns, an author
 * spotlight and a colophon. Cards and every other module stay the platform's.
 */
export default defineZonePackage({
  slug: 'books',
  css,
  slots: { header: BooksHeader, hero: BooksHero, footer: BooksFooter,
    modules: { shelf: BooksShelf, 'editorial-list': BooksColumns, people: BooksSpotlight } },
});
