export type LibraryEntryStateWrite = string;

// The native shelf's public-Type grammar. Bound URL input before testing the opaque value.
export function libraryShelfType(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 && /^[a-z][a-z0-9_]*:[\x21-\x7e]+$(?![\s\S])/.test(value)
    ? value
    : undefined;
}

const entryStateId = /^[a-z][a-z0-9_.-]{0,63}$(?![\s\S])/;

export function libraryEntryStateWrite(value: string | undefined): LibraryEntryStateWrite | undefined {
  return value !== undefined && entryStateId.test(value) ? value : undefined;
}

export const shelfLayouts = ['grid', 'list', 'table'] as const;
export type ShelfLayout = (typeof shelfLayouts)[number];
export const shelfSizes = ['s', 'm', 'l'] as const;
export type ShelfSize = (typeof shelfSizes)[number];

export const shelfColumnIds = [
  'cover',
  'title',
  'type',
  'status',
  'progress',
  'added',
  'finished',
  'lastActivity',
] as const;
export type PersonalShelfColumnId = (typeof shelfColumnIds)[number];

/** A bounded display value. Omission and an explicit complete set remain distinct URL choices. */
export function shelfColumns(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 128) return undefined;
  const fields = value.split(',');
  if (fields.some((field) => !(shelfColumnIds as readonly string[]).includes(field))) return undefined;
  const chosen = shelfColumnIds.filter((field) => field === 'title' || fields.includes(field));
  return chosen.join(',');
}

export type ShelfDisplay = {
  layout: ShelfLayout;
  size: ShelfSize;
  columns?: string;
  layoutExplicit?: boolean;
  sizeExplicit?: boolean;
  columnsExplicit?: boolean;
};

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
const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
export const SHELF_CURSOR_MAX_LENGTH = 2048;

export type ShelfAddressField = 'type' | 'state' | 'label' | 'cursor';

export function shelfCursor(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= SHELF_CURSOR_MAX_LENGTH ? value : undefined;
}

/** Keep unsupported nonempty selectors visible to the route so it can ask for an explicit correction. */
export function shelfAddressIssues(search: Record<string, unknown>): ShelfAddressField[] {
  const issues: ShelfAddressField[] = [];
  const supplied = (field: ShelfAddressField) =>
    search[field] !== undefined && search[field] !== null && search[field] !== '';
  if (supplied('type') && !libraryShelfType(search.type)) issues.push('type');
  if (supplied('state') && !libraryEntryStateWrite(typeof search.state === 'string' ? search.state : undefined))
    issues.push('state');
  if (supplied('label') && !(typeof search.label === 'string' && routeId.test(search.label))) issues.push('label');
  if (supplied('cursor') && !shelfCursor(search.cursor)) issues.push('cursor');
  return issues;
}

const shelfAddressKeys = [
  'type',
  'state',
  'label',
  'orderBy',
  'direction',
  'layout',
  'size',
  'columns',
  'cursor',
] as const;

/** Remove only the chosen address field; keep the remaining raw selections and display choices intact. */
export function shelfAddressCorrectionHref(
  locale: string,
  search: Record<string, unknown>,
  clear: ShelfAddressField,
): string {
  const params = new URLSearchParams();
  for (const key of shelfAddressKeys) {
    if (key === clear) continue;
    const value = search[key];
    if (typeof value === 'string') params.set(key, value);
  }
  const query = params.toString();
  return query ? `/${locale}/library?${query}` : `/${locale}/library`;
}

/** What the shelf's address says. A value that is not one of the documented ones is absent. */
export type ShelfSearch = {
  type?: string;
  state?: LibraryEntryStateWrite;
  orderBy?: ShelfSort['orderBy'];
  direction?: ShelfSort['direction'];
  layout?: ShelfLayout;
  size?: ShelfSize;
  columns?: string;
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
  const columns = shelfColumns(search.columns);
  const cursor = shelfCursor(search.cursor);
  const label = typeof search.label === 'string' && routeId.test(search.label) ? search.label : undefined;
  const type = !label ? libraryShelfType(search.type) : undefined;
  return {
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    ...(!label && orderBy ? { orderBy } : {}),
    ...(!label && direction ? { direction } : {}),
    ...(layout ? { layout } : {}),
    ...(size ? { size } : {}),
    ...(columns ? { columns } : {}),
    ...(cursor ? { cursor } : {}),
    ...(label ? { label } : {}),
  };
}

/** The layout and grid size to draw: the address's, or the default. */
export function shelfDisplay(search: ShelfSearch): ShelfDisplay {
  const columns = shelfColumns(search.columns);
  return {
    layout: search.layout ?? defaultLayout,
    size: search.size ?? defaultSize,
    ...(columns ? { columns } : {}),
    layoutExplicit: search.layout !== undefined,
    sizeExplicit: search.size !== undefined,
    columnsExplicit: search.columns !== undefined,
  };
}

/** The address of a shelf view. Defaults stay out of it, and the layout and size are kept unless the caller changes them. */
export function shelfHref(
  locale: string,
  view: {
    type?: string;
    label?: string;
    state?: LibraryEntryStateWrite | null;
    orderBy?: ShelfSort['orderBy'];
    direction?: ShelfSort['direction'];
    layout?: ShelfLayout;
    size?: ShelfSize;
    columns?: string;
    layoutExplicit?: boolean;
    sizeExplicit?: boolean;
    columnsExplicit?: boolean;
    cursor?: string;
  },
): string {
  const params = new URLSearchParams();
  const type = !view.label ? libraryShelfType(view.type) : undefined;
  if (type) params.set('type', type);
  if (view.label) params.set('label', view.label);
  if (view.state) params.set('state', view.state);
  if (!view.label && view.orderBy) params.set('orderBy', view.orderBy);
  if (!view.label && view.direction) params.set('direction', view.direction);
  if (view.layout && (view.layout !== defaultLayout || view.layoutExplicit)) params.set('layout', view.layout);
  if (view.size && (view.size !== defaultSize || view.sizeExplicit)) params.set('size', view.size);
  const columns = shelfColumns(view.columns);
  if (columns && (view.columnsExplicit || view.columns !== undefined)) params.set('columns', columns);
  if (view.cursor) params.set('cursor', view.cursor);
  const query = params.toString();
  return query ? `/${locale}/library?${query}` : `/${locale}/library`;
}
