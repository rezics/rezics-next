import type { WorkAllowance, WorkDimensions, WorkReceipt, IdentityScopeWork, PublicFilterCost, LeafWork } from './scope-execution.ts';
export declare const scopeWorkAxes: readonly ['candidateKeys', 'nativeRows', 'identityMetadataRows', 'emptySeeks', 'nativePoints', 'witnessKeys', 'statements', 'bytes'];
export declare function zeroScopeWork(): WorkDimensions;
/** Compatibility ceilings are independent of the candidate reservation. They never grow on refill. */
export declare function scopeAllowance(keys: number, reservationId: string, remaining?: WorkDimensions): WorkAllowance;
export declare class ScopeWork {
    private spent;
    private readonly root;
    constructor(root: WorkAllowance);
    remaining(): WorkAllowance;
    consume(used: WorkDimensions): void;
    receipt(): WorkReceipt;
    native(receipt: WorkReceipt): void;
    identity(work: IdentityScopeWork): void;
    public(cost: PublicFilterCost): void;
    leaf(used: LeafWork): void;
    leafBudget(): LeafWork | null;
}
