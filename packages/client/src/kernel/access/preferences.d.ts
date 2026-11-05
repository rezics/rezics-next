import type { Pool, PoolClient } from 'pg';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { type Notifications, type NotificationsPatch } from './notification-kinds.ts';
export declare const SHELF_LAYOUTS: readonly ['grid', 'list', 'table'];
export declare const SHELF_TABS: readonly ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'];
export declare const SHELF_SORT_FIELDS: readonly ['last_activity', 'added', 'finished', 'title', 'rating', 'release_date', 'progress'];
export declare const SHELF_SORT_DIRECTIONS: readonly ['asc', 'desc'];
export declare const SHELF_GRID_SIZES: readonly ['small', 'medium', 'large'];
export declare const SHELF_TABLE_COLUMNS: readonly ['cover', 'title', 'creator', 'type', 'status', 'progress', 'rating', 'added', 'started', 'finished', 'last_activity'];
export declare const SHELF_MAX_LAYOUTS = 32;
export declare const SHELF_SCOPE_MAX_LENGTH = 256;
/** `all` or an absolute IRI: a scheme, a colon and no whitespace. */
export declare const SHELF_SCOPE_PATTERN = "^(?:all|[A-Za-z][A-Za-z0-9+.-]*:\\S+)$";
export type ShelfLayout = (typeof SHELF_LAYOUTS)[number];
export type ShelfTab = (typeof SHELF_TABS)[number];
export type ShelfSort = {
    field: (typeof SHELF_SORT_FIELDS)[number];
    direction: (typeof SHELF_SORT_DIRECTIONS)[number];
};
export type Shelf = {
    layouts?: Record<string, ShelfLayout>;
    sorts?: Partial<Record<ShelfTab, ShelfSort>>;
    gridSize?: (typeof SHELF_GRID_SIZES)[number];
    tableColumns?: (typeof SHELF_TABLE_COLUMNS)[number][];
};
/** A JSON Merge Patch (RFC 7396) over {@link Shelf}: `null` removes, an array replaces. */
export type ShelfPatch = {
    layouts?: Record<string, ShelfLayout | null> | null;
    sorts?: Partial<Record<ShelfTab, {
        field?: ShelfSort['field'] | null;
        direction?: ShelfSort['direction'] | null;
    } | null>> | null;
    gridSize?: Shelf['gridSize'] | null;
    tableColumns?: Shelf['tableColumns'] | null;
};
export type AccountPreferences = {
    spoilerLevel: 0 | 1 | 2;
    suitability: 'blur' | 'show';
    shelf: Shelf;
    notifications: Notifications;
    version: number;
};
export declare const DEFAULT_ACCOUNT_PREFERENCES: Readonly<AccountPreferences>;
export type PreferenceChange = {
    expectedVersion: number;
    spoilerLevel?: 0 | 1 | 2;
    suitability?: 'blur' | 'show';
    shelf?: ShelfPatch | null;
    notifications?: NotificationsPatch | null;
};
/** One joined account/preference seek on the recipient's route, including suspended accounts. */
export declare function notificationAllowed(client: Pick<Pool | PoolClient, 'query'>, input: {
    recipient: string;
    kind: string;
}): Promise<boolean>;
/** Shape of a patch: every known part may be `null`; unknown keys are refused at every level. */
export declare function validShelfPatch(patch: unknown): boolean;
/** The shelf after a patch, or `null` when the patch or the merged result breaks a rule. */
export declare function mergeShelf(stored: Shelf, patch: ShelfPatch | null): Shelf | null;
/** One account-key seek, at most one row; missing storage means the defaults. */
export declare function readAccountPreferences(client: Pick<Pool | PoolClient, 'query'>, accountId: string): Promise<AccountPreferences>;
/** Serializable read/compare/write touches one preference row and the command receipt.
 * The acting account alone owns this state, including in an operator-opened session.
 */
export declare function createPreferenceCommands(config: {
    pool: Pool;
    access: Access;
    clock: () => Date;
}): {
    setPreferences(context: AccessContext & {
        actor: Actor;
    }, input: PreferenceChange & {
        accountId: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        version: number;
        spoilerLevel: 0 | 1 | 2;
        suitability: "blur" | "show";
        shelf: Shelf;
        notifications: Notifications;
    }>>;
};
