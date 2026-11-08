/** Effect-free shelf query vocabulary shared by readers, writers and transport. */
type EntryState = string;
export declare const ENTRY_STATES: readonly ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
export type LegacyEntryState = (typeof ENTRY_STATES)[number];
export declare function isLegacyEntryState(value: string): value is LegacyEntryState;
/** Original profile vocabulary grammar; chronological reads preserve the exact state identifier. */
export declare function isShelfEntryState(value: string): boolean;
export declare const SHELF_ORDERS: readonly ['lastActivity', 'finishedAt', 'createdAt', 'personalScore', 'priority', 'title'];
export declare const SHELF_DIRECTIONS: readonly ['desc', 'asc'];
export type ShelfOrder = (typeof SHELF_ORDERS)[number];
export type ShelfDirection = (typeof SHELF_DIRECTIONS)[number];
/** The sort each status tab opens with. The web sends these explicitly; the API has no per-state default. */
export declare const SHELF_DEFAULT_ORDER: Readonly<Record<LegacyEntryState, ShelfOrder>>;
export declare const MAX_SHELF_PAGE_SIZE = 100;
export declare const DEFAULT_SHELF_PAGE_SIZE = 20;
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
export declare function normalizeShelfQuery(query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>): ShelfQuery;
export declare function shelfCursorBinding(accountId: string, query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>): ShelfCursorBinding;
export declare function shelfTypeCursorBinding(accountId: string, limit: number): ShelfCursorBinding;
export declare const SHELF_TYPE_CHUNK_BYTES = 256;
export declare const SHELF_TYPE_EDGE_BATCH = 100;
export declare const SHELF_TYPE_RESPONSE_BYTES: number;
export declare const SHELF_LIST_ACTION = "library_entry:list";
export declare const SHELF_PROGRESS_ACTION = "progress_session:list";
export declare const SHELF_PROGRESS_GATE = "reading_progress";
export {};
