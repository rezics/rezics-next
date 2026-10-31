import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { IdentityJobRef, IdentityNativeReceipt, IdentityReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
export type IdentitySourceConsumerReference = Readonly<{
    receipt: Exclude<IdentityReceipt, {
        kind: 'subject.merge';
    }>;
    job: IdentityJobRef;
    source: IdentityNativeReceipt;
    sourceDigest: string;
    barrier: HistoryBarrier;
    /** subject is the original source key's account, distinct from requester/decider. */
    erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
    [identitySourceConsumerCustody]: true;
}>;
/** Required additive owner exchange, not a caller proof or an installed adapter. Native
 * implementations must resolve these generations from the original accepted input. */
export type IdentitySourceConsumerGeneration = Readonly<{
    replayGeneration: string;
    undoGeneration: string;
    restoreGeneration: string;
}>;
export type IdentitySourceConsumerWork = IdentitySourceConsumerGeneration & Readonly<{
    allowance: NativeStepWork;
}>;
export type IdentitySourceConsumerContext = Readonly<{
    deadline: number;
    identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerDisposition = 'discharged' | 'transferred';
export type IdentitySourceScopeConsumerWork = Readonly<{
    allowance: WorkAllowance;
    /** Native owners provide proved SQL bounds. Unknown SQL must be refused before dispatch. */
    footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
}>;
/** Prepare retained native custody, then advance one exhaustive consumer-cut step. Missing
 * native fences or technical receiving authority leave the original bytes retained. */
export declare function readIdentitySourceConsumerCustody(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerCustody | null>;
/** Same genuine live original-home command, fixed indexed points, no foreign checkout. */
export declare function verifyIdentitySourceConsumerCustody(tx: CommandTransaction, reference: IdentitySourceConsumerReference, proof: IdentitySourceConsumerCustody): Promise<boolean>;
export {};
