/** Library-owned request ledger. Search's ScopeWork is a structural consumer, not the owner. */
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../contract/work-dimensions.ts';
export declare const WORK_AXES: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes"];
export declare function zeroWorkDimensions(): WorkDimensions;
export declare function workAllowance(keys: number, reservationId: string, remaining?: WorkDimensions): WorkAllowance;
export declare class CollectionWorkLedger {
    private spent;
    private readonly root;
    readonly plan: unknown;
    constructor(root: WorkAllowance, plan?: unknown);
    remaining(): WorkAllowance;
    consume(used: WorkDimensions): void;
    receipt(): WorkReceipt;
    native(receipt: WorkReceipt): void;
}
