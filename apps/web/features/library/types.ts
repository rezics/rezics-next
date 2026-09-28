import type { ReaderStateItem } from '../catalogue/reader-store.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import type { MainClient } from '../discover/types.ts';
import type { ContinueItem, Loaded } from '../feed/types.ts';

// Main's reader library as Library reads it (`services/main/src/routes/library.ts`,
// `continue.ts`, `reviews.ts`, `profiles.ts`), taken from the typed Eden client
// so a contract change breaks this build.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Me = MainClient['v1']['me'];

export type MyShelves = Ok<Me['shelves']['get']>;
export type ShelfStatus = MyShelves['statusShelves'][number]['status'];
/** A shelf the reader made: a Collection they curate, public or private on its own. */
export type CustomShelf = MyShelves['items'][number];
export type StatusShelfItem = Ok<ReturnType<Me['shelves']['status']>['works']['get']>['items'][number];
export type LibraryVisibility = Ok<ReturnType<MainClient['v1']['agents']>['library-visibility']['get']>;
export type Visibility = LibraryVisibility['visibility'];
export type Review = Ok<ReturnType<MainClient['v1']['works']>['reviews']['get']>['items'][number];
export type { ContinueItem, Loaded, ReaderStateItem };

/** The custom shelves one Work is on, as the reader-state read names them. */
export type ShelfMembership = ReaderStateItem['customShelves'][number];

/**
 * One Work in the reader's library: what sorting and the rows need, as plain
 * data that crosses to the browser. `status` is null only on a custom shelf,
 * for a Work the reader has not put on a status shelf.
 */
export interface LibraryItem {
  work: CatalogueWork;
  status: ShelfStatus | null;
  /** The status's compare-and-set version; 0 when it has none. */
  version: number;
  /** When the Work reached its current status shelf, Goodreads' "date added". */
  shelvedAt: string | null;
  /** Reading dates, which Main keeps only for Read. */
  startedOn: string | null;
  finishedOn: string | null;
  /** The reader's own Global rating on its 1–5 scale, or null. */
  rating: number | null;
  /** When the reader last saved reading progress. */
  lastReadAt: string | null;
  customShelves: readonly ShelfMembership[];
  /** On a custom shelf, the member's occurrence, which removal names. */
  occurrence?: string;
}

/**
 * Where a Work in progress stands, from Main's Continue read and the Work's
 * chapter count: the next unread chapter and how much is left.
 */
export interface ReadingProgress {
  next: { title: string | null; href: string } | null;
  left: { value: number; kind: 'exact' | 'lower-bound' } | null;
  /** Chapters read of all, when both are exact. */
  chapters: { read: number; total: number } | null;
}

/** An item as a page of the library shows it, with what only the page's rows need. */
export interface LibraryRow extends LibraryItem {
  /** Only for Works on Currently reading. */
  progress?: ReadingProgress | null;
  /** The reader's review, only for Read in the list; `undefined` where it was not read. */
  review?: Loaded<Review | null>;
}

/** What Library says about the whole reader library before a shelf is chosen. */
export interface LibraryOverview {
  agent: string;
  counts: Record<ShelfStatus, number>;
  customShelves: readonly CustomShelf[];
  visibility: Loaded<LibraryVisibility>;
  /** The standing Global rating question; without one, ratings and reviews are not drawn. */
  ratingContext: string | null;
}
