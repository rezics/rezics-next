import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { shellReader } from '../shell/communities-read.ts';
import { readCurrentlyReading as currentlyReading, readFollowedAuthors as followedAuthors, readOverview as overview,
  readReadingYear as readingYear, readShelfView as shelfView, readYearlyGoal as yearlyGoal }
  from './books-library-recorded-page.ts';
import type { LibraryState } from './state.ts';

export type { ShelfView } from './books-library-recorded-page.ts';
export { readCustomShelves, statusShelfItems } from './books-library-recorded-page.ts';

/** The Agent Library reads as; null when the session has none that may act. */
export const libraryReader = cache(async () => {
  const reader = await shellReader();
  return reader.actingSubject ? { ...reader, actingSubject: reader.actingSubject } : null;
});

/** A dated finish is the unit of the yearly goal; undated Read works do not advance it. */
export const readYearlyGoal = cache(async (year: number) => yearlyGoal(await libraryReader(), year));

export const readReadingYear = cache(async (year: number) => readingYear(await libraryReader(), year));

/** Status counts, the reader's custom shelves, who may see the status shelves, and the rating question. */
export const readOverview = cache(async () => overview(await libraryReader()));

/**
 * The chosen shelf as one Main page, with what that page's rows show:
 * reader state, reading progress and, in the list, the reader's reviews.
 */
export async function readShelfView(state: LibraryState, locale: UiLocale) {
  return shelfView(await libraryReader(), state, locale);
}

/**
 * Currently reading, for the top of All: one Main page of the reading shelf,
 * most recently read first, each with where to continue.
 */
export async function readCurrentlyReading(locale: UiLocale) {
  return currentlyReading(await libraryReader(), locale);
}

/**
 * The first page of authors the reader follows (Main pages them eight at a
 * time), each with their newest Work on REZICS. Main answers 409 when the
 * follows changed during the read; it is read again, once.
 */
export async function readFollowedAuthors(locale: UiLocale) {
  return followedAuthors(await libraryReader(), locale);
}
