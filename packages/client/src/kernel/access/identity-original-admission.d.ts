import type { Pool, PoolClient } from 'pg';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import type { HistoryRegistry } from '../history/registry.ts';
import type { WorkClient } from '../work/client.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
export declare const IDENTITY_ORIGINAL_DEADLINE_MS = 5000;
export declare const ORIGINAL_AXES: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "nativePoints", "witnessKeys", "statements", "bytes", "emptySeeks"];
/** A local SQL declaration. An absent child declaration is represented separately, never by zero. */
export declare function originalControlWork(rows: number, points: number, statements: number, bytes: number, emptySeeks?: number): WorkDimensions;
export declare function originalWorkVector(work: WorkDimensions): readonly number[];
export declare function sumOriginalControl(...parts: readonly WorkDimensions[]): WorkDimensions;
export declare const ORIGINAL_NATIVE_CONTROL: WorkDimensions;
export declare const HISTORY_ORIGINAL_CONTROL: Readonly<{
    discovery: WorkDimensions;
    native: WorkDimensions;
    registry: WorkDimensions;
    select: WorkDimensions;
    barrier: WorkDimensions;
    previous: WorkDimensions;
    insert: WorkDimensions;
    lease: WorkDimensions;
}>;
export declare const HISTORY_ORIGINAL_SELECTION: WorkDimensions;
export declare const HISTORY_ORIGINAL_VALIDATION: WorkDimensions;
export declare const HISTORY_ORIGINAL_SETTLEMENT: WorkDimensions;
/** Closed local part of advanceSharedHistory, ending BEFORE any minimizer/readiness/receiving
 * child. Alternative local branches are reserved inclusively. The eight-row page still selects
 * only its first artifact. History seal's family trigger has its own fixed nine-family bound. */
export declare const HISTORY_SELECTED_LOCAL_CONTROL: Readonly<{
    transaction: WorkDimensions;
    job: WorkDimensions;
    dispatchPosition: WorkDimensions;
    barrier: WorkDimensions;
    partition: WorkDimensions;
    seal: WorkDimensions;
    progressInsert: WorkDimensions;
    progressLock: WorkDimensions;
    epochReset: WorkDimensions;
    gapReset: WorkDimensions;
    page: WorkDimensions;
    applicable: WorkDimensions;
    classify: WorkDimensions;
    unavailableHome: WorkDimensions;
    emptyProgress: WorkDimensions;
    emptySeal: WorkDimensions;
    nextHome: WorkDimensions;
    phaseChange: WorkDimensions;
    verifyHome: WorkDimensions;
    verifyTransition: WorkDimensions;
    authProof: WorkDimensions;
    pending: WorkDimensions;
}>;
export declare const HISTORY_ORIGINAL_LOCAL_ALLOWANCE: WorkDimensions;
export declare const IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING = "identity-history-original-source-transfer-unavailable";
export declare class IdentityOriginalUnavailable extends Error {
    readonly gap: string;
    constructor(gap: string);
}
export type SelectedHistoryPosition = Readonly<{
    job_id: string;
    partition_no: number;
    account_route: number;
    account_id: string;
    barrier_id: string;
    barrier_version: number;
    barrier_at: string;
    phase: 'scan' | 'verify' | 'pending' | 'complete';
    scan_partition: number;
    verify_partition: number;
    scan_type: string | null;
    scan_locator: Buffer | null;
    registry_digest: string;
    registry_generation: string;
}>;
type Binding = Omit<SelectedHistoryPosition, 'scan_locator'> & Readonly<{
    scan_locator: string | null;
}>;
/** Exact native position, not a random reservation UUID or a lease timestamp. */
export declare function historyOriginalPosition(job: SelectedHistoryPosition): Binding;
declare const originalTransfer: unique symbol;
export type IdentityOriginalTransfer = Readonly<{
    [originalTransfer]: true;
}>;
export type HistoryOriginalDependencies = Readonly<{
    pool: Pool;
    client: WorkClient;
    registry: HistoryRegistry;
}>;
/** Private receiving provenance. Copying this opaque object does not copy admission. */
export declare function currentIdentityOriginalTransfer(deps: HistoryOriginalDependencies, jobId: string): IdentityOriginalTransfer | null;
/** The missing Source and Library producer prices remain null. Local prefix capacity cannot fund them. */
export declare function identityOriginalRemainder(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string): Readonly<{
    originalId: string;
    deadline: number;
    position: Binding;
    source: WorkDimensions | null;
    library: WorkDimensions | null;
}>;
/** Revalidate inside the real locked operational position, closing the gap after the
 * released native consume command. This query borrows no native command authority. */
export declare function lockSelectedHistoryOriginalPosition(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, job: SelectedHistoryPosition, tx: Pick<PoolClient, 'query'>): Promise<void>;
/** The trusted worker is the only producer. Selection is bounded before checkout; native
 * command identity and position commit before the capability can escape to its callback. */
export declare function withSelectedHistoryOriginal<T>(deps: HistoryOriginalDependencies, body: (jobId: string, transfer: IdentityOriginalTransfer) => Promise<T>): Promise<T | null>;
/** A separate committed debit precedes affected dispatch. The following body may roll back,
 * throw, or fail to dispatch; none of those paths restore this original's capacity. */
export declare function consumeSelectedHistoryOriginal(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string): Promise<void>;
/** The additive controls are separate from every retained local component. All branches
 * are inclusive: even a refused/failed callback retains its entire prepaid reservation.
 * Reads use full original/job keys; the only fanout is the four fixed vector partitions.
 * Zero candidate/identity-metadata/witness axes mean these SQL bodies have none of those
 * operations; they are not conversions from the legacy five-axis child declarations. */
export declare const HISTORY_ORIGINAL_TRANSFER_CONTROL: Readonly<{
    discoveryControls: WorkDimensions;
    allocationInsert: WorkDimensions;
    entryBarrier: WorkDimensions;
    progress: WorkDimensions;
    settlementAllocation: WorkDimensions;
    grant: WorkDimensions;
    finish: WorkDimensions;
}>;
export declare const ADDITIONAL_ORIGINAL_TRANSFER_CONTROL: WorkDimensions;
/** Owner-installed body declarations, not grants. Accounts reads these ONLY from the
 * actual Source and Library modules before admission. Public call sites supply no price.
 * The source declaration includes all reached History, inventory, receiving, H/G/A,
 * outbox/released/current/final validators, settings, failure and rollback invocations.
 * Library's declaration includes all actual page/verifier/planner/seal/fence bodies. */
export type IdentityHistoryOriginalBodyDeclaration = Readonly<{
    work: WorkDimensions;
    engineRequests: 0;
}>;
/** Called inside the real job transaction, after native progress and before COMMIT.
 * The query surface is deliberately operational: it issues no CommandTransaction authority.
 * Settlement cannot infer progress merely from a later changed job observation. */
export declare function recordSelectedHistoryOriginalProgress(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string, tx: Pick<PoolClient, 'query'>): Promise<void>;
declare const privateGrant: unique symbol;
export type IdentityOriginalSourceGrant = Readonly<{
    [privateGrant]: true;
}>;
export type IdentityOriginalSourceContext = Readonly<{
    original: IdentityOriginalSourceGrant;
    originalId: string;
    jobId: string;
    position: Binding;
    deadline: number;
    native: WorkDimensions;
    library: NativeCollectionWork;
}>;
/** Source uses this before each actual native dispatch; the prepaid original partition
 * is cumulative and cannot refill on retry, failure, rollback or an unavailable result. */
export declare function reserveIdentityOriginalSourceWork(deps: HistoryOriginalDependencies, token: IdentityOriginalSourceGrant, jobId: string, amount: WorkDimensions): void;
/** Every Library descendant receives this exact object, including the final same-command
 * fence. This accessor neither creates a reservation UUID nor constructs another ledger. */
export declare function identityOriginalLibraryWork(deps: HistoryOriginalDependencies, token: IdentityOriginalSourceGrant, jobId: string): NativeCollectionWork;
/** Sole Accounts private prepaid Source callback. No structural funding argument, caller
 * ceiling, fresh UUID or operational-to-command cast exists on this route. */
export declare function withIdentityOriginalSourceTransfer<T>(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string, body: (context: IdentityOriginalSourceContext) => Promise<T>): Promise<T>;
/** Exact required private caller operand. The installed History caller must enter its
 * existing unit with Source's authentic prepaid frame and this SAME Library ledger;
 * withAgentIdentityHistoryUnit's current independent configured allocation is ineligible. */
export type PrepaidAgentIdentityHistoryUnit = <T>(deps: HistoryOriginalDependencies & Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    clock: () => Date;
}>, parent: IdentityOriginalSourceContext, body: (funded: import('../history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceContext) => Promise<T>) => Promise<T>;
/** Fixed native caller integration only; neither a callback parameter nor a module path
 * from the request can install the missing Source/History producer. Until its actual
 * prepaid caller is installed, only this child dispatch refuses. */
export declare function withSelectedHistoryOriginalChild<T>(deps: HistoryOriginalDependencies & Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    clock: () => Date;
}>, token: IdentityOriginalTransfer, jobId: string, body: (funded: import('../history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceContext) => Promise<T>): Promise<T>;
/** Preserve the actual operational client and its transaction, with per-await liveness.
 * This wrapper deliberately creates no currentCommand/currentCommandResources entry.
 * Failure ROLLBACK remains possible after expiry and is prepaid by the local envelope. */
export declare function guardSelectedHistoryOriginalTransaction(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string, client: PoolClient): PoolClient;
export {};
