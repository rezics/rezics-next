import type { OperationalWorkCost } from '../history/operational-work-budget.ts';
export declare const SELECTED_AXES: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
export type SelectedCost = OperationalWorkCost & Readonly<{
    engineRequests: number;
}>;
/** Named fields, never positional conversion from a foreign declaration. */
export declare const selectedCost: (rows: number, points: number, statements: number, bytes: number) => SelectedCost;
export declare function sumSelectedCost(...parts: readonly SelectedCost[]): SelectedCost;
/** Literal complete LOCAL dispatch partitions. Child native SQL/Source prices are additional.
 * Full-key misses consume the same bound. No debit is undone by failure/rollback. */
export declare const SELECTED_COST: Readonly<{
    issue: SelectedCost;
    release: SelectedCost;
    consume: SelectedCost;
    continuation: SelectedCost;
    enqueue: SelectedCost;
    hold: SelectedCost;
    transaction: SelectedCost;
    rollback: SelectedCost;
    original: SelectedCost;
    tuple: SelectedCost;
    association: SelectedCost;
    result: SelectedCost;
}>;
export declare const SELECTED_CLEANUP_DECLARATION: SelectedCost;
/** One select, one apply and at most one reached failure; no transaction or SDK retry refills it. */
export declare const SELECTED_LOCAL_DECLARATION: SelectedCost;
