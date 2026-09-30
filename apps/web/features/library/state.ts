import type { ShelfStatus } from './types.ts';

// Library's address: `/library?shelf=read&sort=title&order=asc&view=grid&cursor=…`.
// Every choice is part of the URL, so a view can be shared, reloaded and
// reached without script; defaults are left out. `cursor` is the continuation
// Main returned for this page. Pure functions shared by the route, the
// components and their tests.

/** The status shelves in the order Library and profiles list them. */
export const statusShelves = ['reading', 'want-to-read', 'read'] as const satisfies readonly ShelfStatus[];

export type LibraryShelf = { kind: 'all' } | { kind: 'status'; status: ShelfStatus }
  /** A custom shelf, by its Collection's UUID. */
  | { kind: 'custom'; id: string };

/**
 * Orders Main applies to a status shelf. A custom shelf keeps the order of
 * its Collection; All is the shelf list, not a merged inventory.
 */
export const librarySorts = ['added', 'title', 'rating', 'last-read', 'finished'] as const;
export type LibrarySort = (typeof librarySorts)[number];
export type SortOrder = 'asc' | 'desc';
export type LibraryLayout = 'list' | 'grid';

export interface LibraryState {
  shelf: LibraryShelf;
  sort: LibrarySort;
  order: SortOrder;
  layout: LibraryLayout;
  /** Main's continuation for this page, or null on the first page. */
  cursor: string | null;
}

/** Each sort's first direction: newest, highest and A to Z first. */
export const naturalOrder: Record<LibrarySort, SortOrder> = {
  added: 'desc', title: 'asc', rating: 'desc', 'last-read': 'desc', finished: 'desc',
};

/** The sorts a shelf offers. Date finished means something only on Read. All is not a sorted shelf. */
export function sortsFor(shelf: LibraryShelf): readonly LibrarySort[] {
  if (shelf.kind !== 'status') return [];
  if (shelf.status === 'read') return librarySorts;
  return librarySorts.filter(sort => sort !== 'finished');
}

/** Main refuses a cursor longer than this (`routes/library.ts`). */
const CURSOR_LIMIT = 2048;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

export function parseShelf(value: string | undefined): LibraryShelf {
  const status = statusShelves.find(item => item === value);
  if (status) return { kind: 'status', status };
  return value && uuid.test(value) ? { kind: 'custom', id: value } : { kind: 'all' };
}

export function parseLibraryState(params: Record<string, string | string[] | undefined>): LibraryState {
  const shelf = parseShelf(one(params.shelf));
  const offered = sortsFor(shelf);
  const sort = offered.find(item => item === one(params.sort)) ?? 'added';
  const order = one(params.order) === 'asc' || one(params.order) === 'desc'
    ? one(params.order) as SortOrder : naturalOrder[sort];
  const cursor = one(params.cursor);
  return { shelf, sort, order, layout: one(params.view) === 'grid' ? 'grid' : 'list',
    cursor: shelf.kind !== 'all' && cursor && cursor.length <= CURSOR_LIMIT ? cursor : null };
}

export const shelfKey = (shelf: LibraryShelf) =>
  shelf.kind === 'all' ? 'all' : shelf.kind === 'status' ? shelf.status : shelf.id;

/**
 * The address of a view, before the locale prefix. A change of shelf, sort or
 * order starts again at the first page; a change of layout keeps the cursor.
 * A sort the destination shelf does not offer is left off, so Read's date
 * finished does not travel onto Currently reading.
 */
export function libraryHref(state: LibraryState, change: Partial<LibraryState> = {}): string {
  const next = { ...state, ...change };
  const restart = ['shelf', 'sort', 'order'].some(key => key in change);
  const cursor = restart && !('cursor' in change) ? null : next.cursor;
  const offered = sortsFor(next.shelf);
  const sort = offered.find(item => item === next.sort) ?? 'added';
  const order = offered.includes(next.sort) ? next.order : naturalOrder[sort];
  const search = new URLSearchParams();
  if (next.shelf.kind !== 'all') search.set('shelf', shelfKey(next.shelf));
  if (offered.length && sort !== 'added') search.set('sort', sort);
  if (offered.length && order !== naturalOrder[sort]) search.set('order', order);
  if (next.layout === 'grid') search.set('view', 'grid');
  if (cursor) search.set('cursor', cursor);
  const query = search.toString();
  return query ? `/library?${query}` : '/library';
}

/** A sort with its own first direction, as choosing it from the menu gives. */
export const withSort = (state: LibraryState, sort: LibrarySort): Partial<LibraryState> =>
  ({ sort, order: naturalOrder[sort] });
