export type LibraryEntryStateWrite = string;

const entryStateId = /^[a-z][a-z0-9_.-]{0,63}$(?![\s\S])/;

export function libraryEntryStateWrite(value: string | undefined): LibraryEntryStateWrite | undefined {
  return value !== undefined && entryStateId.test(value) ? value : undefined;
}

export const shelfLayouts = ['grid', 'list', 'table'] as const;
export type ShelfLayout = (typeof shelfLayouts)[number];
export const shelfSizes = ['s', 'm', 'l'] as const;
export type ShelfSize = (typeof shelfSizes)[number];

export const shelfOrders = ['lastActivity', 'createdAt', 'finishedAt'] as const;
export const shelfDirections = ['desc', 'asc'] as const;
export type ShelfSort = { orderBy: (typeof shelfOrders)[number]; direction: (typeof shelfDirections)[number] };

/** Only the historic states with an adopted date default differ; every other exact profile state uses activity. */
export function shelfSort(search: Pick<ShelfSearch, 'state' | 'orderBy' | 'direction'>): ShelfSort {
  return {
    orderBy:
      search.orderBy ??
      (search.state === 'planned' ? 'createdAt' : search.state === 'completed' ? 'finishedAt' : 'lastActivity'),
    direction: search.direction ?? 'desc',
  };
}

const defaultLayout: ShelfLayout = 'grid';
const defaultSize: ShelfSize = 'm';
const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What the shelf's address says. A value that is not one of the documented ones is absent. */
export type ShelfSearch = {
  state?: LibraryEntryStateWrite;
  orderBy?: ShelfSort['orderBy'];
  direction?: ShelfSort['direction'];
  layout?: ShelfLayout;
  size?: ShelfSize;
  cursor?: string;
  label?: string;
};

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function validateShelfSearch(search: Record<string, unknown>): ShelfSearch {
  const state = typeof search.state === 'string' ? libraryEntryStateWrite(search.state) : undefined;
  const orderBy = oneOf(shelfOrders, search.orderBy);
  const direction = oneOf(shelfDirections, search.direction);
  const layout = oneOf(shelfLayouts, search.layout);
  const size = oneOf(shelfSizes, search.size);
  const cursor = typeof search.cursor === 'string' && search.cursor ? search.cursor : undefined;
  const label = typeof search.label === 'string' && routeId.test(search.label) ? search.label : undefined;
  return {
    ...(state ? { state } : {}),
    ...(!label && orderBy ? { orderBy } : {}),
    ...(!label && direction ? { direction } : {}),
    ...(layout ? { layout } : {}),
    ...(size ? { size } : {}),
    ...(cursor ? { cursor } : {}),
    ...(label ? { label } : {}),
  };
}

/** The layout and grid size to draw: the address's, or the default. */
export function shelfDisplay(search: ShelfSearch): { layout: ShelfLayout; size: ShelfSize } {
  return { layout: search.layout ?? defaultLayout, size: search.size ?? defaultSize };
}

/** The address of a shelf view. Defaults stay out of it, and the layout and size are kept unless the caller changes them. */
export function shelfHref(
  locale: string,
  view: {
    label?: string;
    state?: LibraryEntryStateWrite | null;
    orderBy?: ShelfSort['orderBy'];
    direction?: ShelfSort['direction'];
    layout?: ShelfLayout;
    size?: ShelfSize;
    cursor?: string;
  },
): string {
  const params = new URLSearchParams();
  if (view.label) params.set('label', view.label);
  if (view.state) params.set('state', view.state);
  if (!view.label && view.orderBy) params.set('orderBy', view.orderBy);
  if (!view.label && view.direction) params.set('direction', view.direction);
  if (view.layout && view.layout !== defaultLayout) params.set('layout', view.layout);
  if (view.size && view.size !== defaultSize) params.set('size', view.size);
  if (view.cursor) params.set('cursor', view.cursor);
  const query = params.toString();
  return query ? `/${locale}/library?${query}` : `/${locale}/library`;
}
