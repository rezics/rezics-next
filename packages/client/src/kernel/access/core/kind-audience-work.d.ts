import { type AccessWork, type AccessWorkDimensions } from '../contract/bounds.ts';
import type { AccessActor } from '../contract/index.ts';
export type KindAudienceFormulaShape = {
    readonly members: number;
    readonly groups: number;
    readonly roles: number;
    readonly assignment: boolean;
    readonly scope: boolean;
};
export declare function kindAudienceActorShape(actor: AccessActor, membershipLimit: number): KindAudienceFormulaShape;
export declare function kindAudienceOverhead(statementBytes: number): AccessWorkDimensions;
export declare function kindAudienceAccessWork(shape: KindAudienceFormulaShape, formula: AccessWork, extra: readonly AccessWork[]): AccessWork;
export declare function identityRecoveryApplies(error: unknown, receiptKey: string): boolean;
export declare function identityReceiptKey(receipt: {
    kind: string;
    account: string;
    receipt: string;
}): string;
