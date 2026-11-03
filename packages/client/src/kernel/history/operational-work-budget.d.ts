import type { Pool, PoolClient } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkClient } from '../work/client.ts';
import { OPERATIONAL_WORK_AXES } from './operational-work-axes.ts';
/** The eight native axes. This allocation belongs only to the operational History producer. */
export { OPERATIONAL_WORK_AXES };
export type OperationalWorkCost = Readonly<Record<(typeof OPERATIONAL_WORK_AXES)[number], number>>;
export declare function sumOperationalWork(...parts: readonly OperationalWorkCost[]): OperationalWorkCost;
export declare const OPERATIONAL_WORK_COST: Readonly<{
    attempt: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    originalLookup: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sourceDomain: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    positionAllocate: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    positionBinding: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    originalIndexes: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkProbe: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkDomain: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkProjectionGuard: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkEnqueue: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkWriter: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    originalInsert: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    originalFinalize: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    seal: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    workInsert: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    locator: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    resolve: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    receivingControl: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    mappingInsert: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    mappingRead: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    sdkReadback: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    writerBarrier: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    replaySeals: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export declare const OPERATIONAL_WORK_REGISTRATION: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare const OPERATIONAL_WORK_RECEIVING: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare const OPERATIONAL_WORK_RECHECK: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare const OPERATIONAL_WORK_TRANSFER_COST: Readonly<{
    resolve: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    verify: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    receive: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    replay: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    retirement: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export type OperationalWorkPhase = keyof typeof OPERATIONAL_WORK_TRANSFER_COST;
/** Three complete attempts share ONE balance. Rollback and failed prefixes are never refunded.
 * The caller's Members/Source/Access bodies are separate declarations, not this child's price. */
export declare const OPERATIONAL_WORK_LOCAL_DECLARATION: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare class OperationalWorkUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
/** Query adapter over the SAME checked-out client. A wait for a connection/lock never
 * extends the original deadline. Cleanup uses the raw client so expiry cannot prevent rollback. */
export declare function operationalWorkDeadlineClient(client: PoolClient, deadline: number): Pick<PoolClient, 'query'>;
export type OperationalWorkOriginal = Readonly<{
    pool: Pool;
    deadline: number;
    workClient?: WorkClient;
}>;
declare const CHILD_PRICES: Readonly<{
    resolve: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    verify: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    receive: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    replay: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    retirement: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    registration: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    attempt: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
type FundedPhase = keyof typeof CHILD_PRICES;
/** Already allocated children of one caller original. Retry is additional work, never a refill. */
export type OperationalWorkChildren = Readonly<Record<FundedPhase | 'retry', NativeCollectionWork>>;
export declare function attachOperationalWorkOriginal(tx: OperationalTransaction, original: OperationalWorkOriginal): void;
export declare function openOperationalWorkOriginal(pool: Pool, deadline: number): OperationalWorkOriginal;
/** Trusted parent composition: the complete History child, including retries, transfers and rollback,
 * is charged before dispatch. A failed or unused child never returns this allocation to its parent. */
export declare function fundOperationalWorkOriginal(parent: NativeCollectionWork, pool: Pool, workClient: WorkClient, deadline: number): OperationalWorkOriginal;
/** Bind the native executor to prepaid caller children without creating a balance from a subtotal.
 * No I/O or charge occurs here. Each phase dispatches its exported price before its native work;
 * failed prefixes retain that charge. Additional attempts use only the original retry allocation.
 * The native executor keeps its absolute deadline policy, with no additional attempt-count cap.
 */
export declare function fundOperationalWorkChildren(children: OperationalWorkChildren, pool: Pool, workClient: WorkClient, deadline: number): OperationalWorkOriginal;
/** Executor entry, before time, Access, checkout or BEGIN. Contention retains this same original. */
export declare function claimOperationalWorkOriginal(original: OperationalWorkOriginal, pool: Pool, workClient: WorkClient, deadline: number): OperationalWorkOriginal;
export declare function debitOperationalWork(original: OperationalWorkOriginal, amount: OperationalWorkCost): void;
export declare function debitOperationalWorkAttempt(original: OperationalWorkOriginal): void;
declare const transfer: unique symbol;
export type OperationalWorkTransfer = {
    readonly [transfer]: true;
};
/** Executor/producer internal. Public issuance verifies the genuine live transaction first. */
export declare function issueOperationalWorkTransfer(tx: OperationalTransaction, original: OperationalWorkOriginal, phase: OperationalWorkPhase, custodyId: string): OperationalWorkTransfer;
export declare function finishOperationalWorkTransfers(tx: OperationalTransaction, committed: boolean): void;
export declare function consumeOperationalWorkTransfer(pool: Pool, token: OperationalWorkTransfer, phase: OperationalWorkPhase, custodyId: string): Readonly<{
    deadline: number;
}>;
