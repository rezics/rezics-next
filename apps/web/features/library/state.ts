import type { UiLocale } from '../../i18n/define.ts';
import type { LibraryItem, ShelfStatus } from './types.ts';

// Library's address: `/library?shelf=read&sort=title&order=asc&view=grid&page=2`.
// Every choice is part of the URL, so a view can be shared, reloaded and
// reached without script; defaults are left out. Pure functions shared by
// the route, the components and their tests.

/** The status shelves in the order Library and profiles list them. */
export const statusShelves = ['reading', 'want-to-read', 'read'] as const satisfies readonly ShelfStatus[];

export type LibraryShelf = { kind: 'all' } | { kind: 'status'; status: ShelfStatus }
  /** A custom shelf, by its Collection's UUID. */
  | { kind: 'custom'; id: string };

/**
 * Orders over the whole shelf. A custom shelf keeps its own order: Main
 * names its members but not when each was added.
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
  /** One-based. */
  page: number;
}

/** Each sort's first direction: newest, highest and A to Z first. */
export const naturalOrder: Record<LibrarySort, SortOrder> = {
  added: 'desc', title: 'asc', rating: 'desc', 'last-read': 'desc', finished: 'desc',
};

/** The sorts a shelf offers. Date finished means something only where Read Works are. */
export function sortsFor(shelf: LibraryShelf): readonly LibrarySort[] {
  if (shelf.kind === 'custom') return [];
  if (shelf.kind === 'all' || shelf.status === 'read') return librarySorts;
  return librarySorts.filter(sort => sort !== 'finished');
}

/** Works to a page: one reader-state batch, and rows of 2, 3 and 4 covers. */
export const PAGE_SIZE = 24;

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
  const page = Number(one(params.page));
  return { shelf, sort, order, layout: one(params.view) === 'grid' ? 'grid' : 'list',
    page: Number.isSafeInteger(page) && page > 1 ? page : 1 };
}

export const shelfKey = (shelf: LibraryShelf) =>
  shelf.kind === 'all' ? 'all' : shelf.kind === 'status' ? shelf.status : shelf.id;

/**
 * The address of a view, before the locale prefix. A change of shelf, sort or
 * order starts again at the first page; a change of layout keeps the page.
 */
export function libraryHref(state: LibraryState, change: Partial<LibraryState> = {}): string {
  const next = { ...state, ...change };
  const restart = ['shelf', 'sort', 'order'].some(key => key in change);
  const page = restart && !('page' in change) ? 1 : next.page;
  const search = new URLSearchParams();
  if (next.shelf.kind !== 'all') search.set('shelf', shelfKey(next.shelf));
  const sorted = next.shelf.kind !== 'custom';
  if (sorted && next.sort !== 'added') search.set('sort', next.sort);
  if (sorted && next.order !== naturalOrder[next.sort]) search.set('order', next.order);
  if (next.layout === 'grid') search.set('view', 'grid');
  if (page > 1) search.set('page', String(page));
  const query = search.toString();
  return query ? `/library?${query}` : '/library';
}

/** A sort with its own first direction, as choosing it from the menu gives. */
export const withSort = (state: LibraryState, sort: LibrarySort): Partial<LibraryState> =>
  ({ sort, order: naturalOrder[sort] });

function sortValue(item: LibraryItem, sort: LibrarySort): string | number | null {
  switch (sort) {
    case 'added': return item.shelvedAt;
    case 'title': return item.work.title?.value ?? null;
    case 'rating': return item.rating;
    case 'last-read': return item.lastReadAt;
    case 'finished': return item.status === 'read' ? item.finishedOn : null;
  }
}

/**
 * The shelf in the chosen order. Works with nothing to sort by (unrated,
 * never opened, untitled) always come last, in either direction; ties keep
 * the most recently shelved first.
 */
export function sortLibrary(items: readonly LibraryItem[], sort: LibrarySort, order: SortOrder,
  locale: UiLocale): LibraryItem[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const direction = order === 'asc' ? 1 : -1;
  const compare = (a: string | number, b: string | number) => typeof a === 'number' && typeof b === 'number'
    ? a - b : sort === 'title' ? collator.compare(String(a), String(b)) : String(a).localeCompare(String(b));
  return [...items].sort((a, b) => {
    const left = sortValue(a, sort);
    const right = sortValue(b, sort);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const order = compare(left, right);
      if (order) return order * direction;
    }
    return (b.shelvedAt ?? '').localeCompare(a.shelvedAt ?? '') || a.work.id.localeCompare(b.work.id);
  });
}

/** One page of a list; a page past the end shows the last one. */
export function pageOf<T>(items: readonly T[], page: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const shown = Math.min(Math.max(1, page), pages);
  return { items: items.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE), page: shown, pages };
}
