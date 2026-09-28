import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { coverKindOf, type CatalogueWork } from '../catalogue/work.ts';
import type { ImportedBook } from './import-csv.ts';

export interface ImportCandidate { work: string; title: string; authors: string[]; isbn13: string[];
  cover?: CatalogueWork['cover']; kind?: CatalogueWork['kind'] }
export interface OpenLibraryCandidate { workId: string; title: string; authors: string[]; coverId: number | null }
export class ReaderImportBudgetError extends Error {
  constructor(readonly kind: 'search' | 'adoption') { super(`reader import ${kind} budget reached`); }
}
export type ImportMatch = { kind: 'matched' | 'ambiguous' | 'not-found';
  selected: string | null; candidates: ImportCandidate[]; reason: 'isbn' | 'title-author' | 'review' | null };

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();

/** ISBN identifies an edition; otherwise exact title and credited author must agree. */
export function matchImportedBook(book: ImportedBook, candidates: readonly ImportCandidate[]): ImportMatch {
  const distinct = [...new Map(candidates.map(item => [item.work, item])).values()];
  const isbn = book.isbn?.length === 13 ? distinct.filter(item => item.isbn13.includes(book.isbn!)) : [];
  if (isbn.length === 1) return { kind: 'matched', selected: isbn[0]!.work, candidates: isbn, reason: 'isbn' };
  if (isbn.length > 1) return { kind: 'ambiguous', selected: null, candidates: isbn, reason: 'review' };
  const exact = distinct.filter(item => fold(item.title) === fold(book.title)
    && item.authors.some(author => fold(author) === fold(book.author)));
  if (exact.length === 1) return { kind: 'matched', selected: exact[0]!.work,
    candidates: exact, reason: 'title-author' };
  if (exact.length > 1) return { kind: 'ambiguous', selected: null, candidates: exact, reason: 'review' };
  const titles = distinct.filter(item => fold(item.title) === fold(book.title));
  return titles.length ? { kind: 'ambiguous', selected: null, candidates: titles, reason: 'review' }
    : { kind: 'not-found', selected: null, candidates: [], reason: null };
}

/** Main's public title search supplies candidates. Edition ISBNs break exact-title ties. */
export async function lookupImportedBook(book: ImportedBook, _locale: string,
  main: () => MainClient = browserMainApi): Promise<ImportCandidate[]> {
  const query = await main().v1.search.typeahead.get({ query: { prefix: book.title.slice(0, 80) } });
  if (!query.data) throw new Error('Search unavailable');
  const candidates = query.data.items.slice(0, 10);
  const result: ImportCandidate[] = [];
  // At most ten editions reads, only when the export has an ISBN-13.
  for (const item of candidates) {
    const isbn13: string[] = [];
    if (book.isbn?.length === 13) {
      const editions = await main().v1.works({ id: item.work.slice(-36) }).editions.get({ query: { limit: 20 } });
      if (editions.data) isbn13.push(...editions.data.items.flatMap(edition => edition.isbn13 ? [edition.isbn13] : []));
    }
    result.push({ work: item.work, title: item.title?.value ?? '',
      authors: item.authors.flatMap(author => author.displayName ? [author.displayName] : []),
      cover: item.cover, kind: coverKindOf(item.types), isbn13 });
  }
  return result;
}

/** Main performs both source lookups; title/author is a fallback when an ISBN has no result. */
export async function lookupOpenLibraryBook(agent: string, book: ImportedBook,
  main: () => MainClient = browserMainApi): Promise<OpenLibraryCandidate[]> {
  const get = (query: { actingSubject: string; isbn?: string; title?: string; author?: string }) =>
    main().v1.me['library-import']['open-library'].get({ query });
  if (book.isbn) {
    const found = await get({ actingSubject: agent, isbn: book.isbn });
    if (found.status === 429 && (found.error?.value as { code?: string } | undefined)?.code
      === 'reader_import_search_budget') throw new ReaderImportBudgetError('search');
    if (!found.data) throw new Error('Open Library search unavailable');
    if (found.data.items.length) return found.data.items;
  }
  const found = await get({ actingSubject: agent, title: book.title, author: book.author });
  if (found.status === 429 && (found.error?.value as { code?: string } | undefined)?.code
    === 'reader_import_search_budget') throw new ReaderImportBudgetError('search');
  if (!found.data) throw new Error('Open Library search unavailable');
  return found.data.items;
}
