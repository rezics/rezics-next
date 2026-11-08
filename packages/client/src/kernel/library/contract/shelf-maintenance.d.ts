/** Effect-free shelf maintenance phases and readiness vocabulary. */
/** Inputs are exact-owner EXISTS results obtained under account share and serialized gate initialization. */
export interface InitialShelfInputs {
    readonly hasEntries: boolean;
    readonly hasCollections: boolean;
    readonly hasSessions: boolean;
}
export declare function initialShelfReadiness(inputs: InitialShelfInputs): 'ready' | 'backfill';
/** Incomplete history cannot support even a negative delta. This does not grant writer admission. */
export declare function counterWriteMode(ready: boolean): 'active' | 'defer';
export declare const EMPTY_SHELF_GENERATION = "00000000-0000-0000-0000-000000000000";
export declare const SHELF_BACKFILL_PHASES: readonly ['drain', 'session-changes', 'sessions', 'head-inputs', 'heads', 'entries', 'types', 'count-entries', 'count-collections', 'validate', 'publish', 'retire-counts', 'retire-reservations', 'complete'];
export declare const SHELF_COUNTER_PHASES: readonly ['drain', 'count-entries', 'count-collections', 'validate', 'publish', 'retire-counts', 'retire-reservations', 'complete'];
export declare const SHELF_PURGE_PHASES: readonly ['cancel-work', 'bulk-evidence', 'reservations', 'type-sources', 'progress-changes', 'progress-units', 'sessions', 'heads', 'copies', 'entries', 'follows', 'collection-members', 'collections', 'published-logs', 'counts', 'type-nodes', 'type-roots', 'type-values', 'complete'];
export type ShelfMaintenancePhase = (typeof SHELF_BACKFILL_PHASES)[number] | (typeof SHELF_PURGE_PHASES)[number];
export type ShelfMaintenanceKind = 'backfill' | 'counters' | 'purge';
export type ShelfOwner = Readonly<{
    route: number;
    accountId: string;
}>;
export type ShelfMaintenanceCursor = readonly (string | number | boolean | null)[];
