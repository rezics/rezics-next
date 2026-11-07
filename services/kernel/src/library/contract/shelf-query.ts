/** Effect-free shelf query vocabulary shared by readers, writers and transport. */
type EntryState = string;
export const ENTRY_STATES = ['planned', 'in_progress', 'completed', 'paused', 'dropped'] as const;

export type LegacyEntryState = (typeof ENTRY_STATES)[number];

export function isLegacyEntryState(value: string): value is LegacyEntryState {
  return ENTRY_STATES.some((state) => state === value);
}

/** Original profile vocabulary grammar; chronological reads preserve the exact state identifier. */
export function isShelfEntryState(value: string): boolean {
  return /^[a-z][a-z0-9_.-]{0,63}$(?![\s\S])/.test(value);
}

export const SHELF_ORDERS = ['lastActivity', 'finishedAt', 'createdAt', 'personalScore', 'priority', 'title'] as const;

export const SHELF_DIRECTIONS = ['desc', 'asc'] as const;

export type ShelfOrder = (typeof SHELF_ORDERS)[number];

export type ShelfDirection = (typeof SHELF_DIRECTIONS)[number];

/** The sort each status tab opens with. The web sends these explicitly; the API has no per-state default. */
export const SHELF_DEFAULT_ORDER: Readonly<Record<LegacyEntryState, ShelfOrder>> = {
  in_progress: 'lastActivity',
  planned: 'createdAt',
  completed: 'finishedAt',
  paused: 'lastActivity',
  dropped: 'lastActivity',
};

export const MAX_SHELF_PAGE_SIZE = 100;

export const DEFAULT_SHELF_PAGE_SIZE = 20;

/** Effective SQL predicate after exact owner-scoped full-CURIE resolution. Null means unfiltered. */
export type ShelfQuery = {
  state: EntryState | null;
  typeId: string | null;
  orderBy: ShelfOrder;
  direction: ShelfDirection;
  limit: number;
  cursor?: string;
  /** Internal native binding, resolved only after currentness admission. */
  titleGeneration?: string;
};

export type ShelfCursorBinding = {
  route: string;
  viewer: string | null;
  query: Readonly<Record<string, string | number | boolean | null>>;
};

export function normalizeShelfQuery(
  query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>,
): ShelfQuery {
  return {
    state: query.state ?? null,
    typeId: query.typeId ?? null,
    orderBy: query.orderBy,
    direction: query.direction ?? 'desc',
    limit: query.limit ?? DEFAULT_SHELF_PAGE_SIZE,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

export function shelfCursorBinding(
  accountId: string,
  query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>,
): ShelfCursorBinding {
  const { cursor: _cursor, ...effective } = normalizeShelfQuery(query);
  return { route: 'GET /v1/libraryEntries', viewer: accountId, query: effective };
}

export function shelfTypeCursorBinding(accountId: string, limit: number): ShelfCursorBinding {
  return { route: 'GET /v1/libraryShelfTypes', viewer: accountId, query: { limit } };
}

export const SHELF_TYPE_CHUNK_BYTES = 256;

export const SHELF_TYPE_EDGE_BATCH = 100;

export const SHELF_TYPE_RESPONSE_BYTES = 8 * 1024 * 1024;

export const SHELF_LIST_ACTION = 'library_entry:list';

export const SHELF_PROGRESS_ACTION = 'progress_session:list';

export const SHELF_PROGRESS_GATE = 'reading_progress';
