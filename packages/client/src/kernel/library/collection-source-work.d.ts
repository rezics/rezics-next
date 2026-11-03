import type { Pool, PoolClient } from 'pg';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';
/** Constrain dispatch on the SAME Accounts-owned object without closing its counters.
 * This adds a restriction, never original authority or a replacement allocation. */
export declare function bindNativeCollectionWorkLifetime(work: NativeCollectionWork, assertLive: () => void): void;
/** The producer deliberately exposes a restricted object. Apply the native plan to
 * its private target, while every operation and callback still uses that SAME object
 * and its original producer checks. No new proxy, ledger, receipt or allowance. */
export declare function withNativeCollectionWorkAllowance<T>(work: NativeCollectionWork, allowance: WorkAllowance, operation: () => Promise<T>): Promise<T>;
/** Private accounting only. SQL/API owners supply the proved footprint before dispatch. */
export declare class NativeCollectionWork {
    private readonly allowance;
    private readonly deadline;
    private readonly used;
    private readonly held;
    private readonly remaining;
    private closed;
    private pending;
    private readonly planned;
    private open;
    failure: Error | undefined;
    private readonly resultBytes;
    /** A same-snapshot size point admits an otherwise unbounded native projection. */
    admitResultBytes(key: string, bytes: number): void;
    resultByteBound(key: string): number | undefined;
    constructor(allowance: WorkAllowance, deadline: number);
    /** The native caller binds this exact frame to its live operational transaction and deadline. */
    get deadlineAt(): number;
    receipt(): WorkReceipt;
    available(axis: keyof WorkDimensions): number;
    /** Apply one cumulative ceiling to this SAME ledger, including child transfers,
     * checkouts and held transaction cleanup. This creates no allocation or receipt.
     */
    withinAllowance<T>(allowance: WorkAllowance, operation: () => Promise<T>): Promise<T>;
    /** Transfer every declared child before any child can dispatch. Unused child capacity stays
     * held until the entire group finishes; siblings cannot borrow it, retry with it or add a payer.
     * This transfers accounting only. It establishes no Source, Access or physical-work authority.
     */
    transferChildren<K extends string>(declarations: Readonly<Record<K, WorkDimensions>>): Readonly<{
        children: Readonly<Record<K, NativeCollectionWork>>;
        finish(): WorkReceipt;
    }>;
    /** Transfer the remaining reservation to ONE existing producer ledger, never a second allowance.
     * The parent cannot dispatch while it is held. Unlike an SQL footprint this is not itself native work:
     * the child reserves its actual operation bounds before dispatch and returns those charges unchanged.
     */
    compose<T extends {
        readonly work: WorkReceipt;
    }>(operation: (allowance: WorkAllowance) => Promise<T>, ceiling?: WorkDimensions): Promise<T>;
    /** Permanently end this callback-owned ledger; this never releases spent work. */
    close(): void;
    assertReady(): void;
    /** Undefined means unproved, including for an operation expected to return no rows. */
    reserve(footprint: WorkDimensions | undefined, cleanup?: boolean): {
        dispatch(): void;
        query<T>(operation: () => Promise<T>): Promise<T>;
        settle(actual?: Partial<WorkDimensions>): void;
        cancel(): void;
    };
    private unavailable;
}
type Footprint = (sql: string, values: readonly unknown[]) => WorkDimensions | undefined;
type NativeQueryClient = Pick<PoolClient, 'query'>;
/** A prepaid child retains its parent's literal statement policy even when it
 * instruments its own ledger. This checks admission without creating or charging funds. */
export declare function requireNativeCollectionFootprint<T>(pool: Pool, work: NativeCollectionWork, footprint: Footprint, operation: () => Promise<T>): Promise<T>;
/** Observe the original pool/clients: no shadow pool, client proxy or identity/time registration changes. */
export declare function instrumentNativeCollectionWork<T>(pool: Pool, work: NativeCollectionWork, footprint: Footprint, operation: () => Promise<T>, client?: NativeQueryClient): Promise<T>;
/** One physical Source reservation shared by metadata, native drivers, scope and derived work. */
export declare class CollectionSourceLedger {
    readonly initial: WorkAllowance;
    readonly deadline: number;
    private readonly used;
    constructor(initial: WorkAllowance, deadline: number);
    allowance(): WorkAllowance;
    receipt(): WorkReceipt;
    take(receipt: WorkReceipt): void;
    run<T extends {
        work: WorkReceipt;
    }>(call: (allowance: WorkAllowance) => Promise<T>): Promise<T>;
    bounded<T>(cost: Partial<WorkDimensions>, operation: () => Promise<T>, actual?: (result: T) => Partial<WorkDimensions>): Promise<T>;
}
import type { WorkContext } from '../work/registry.ts';
/** The existing Library worker owns native checkpoints. No Source GET writes, scheduler or new participant. */
export declare function registerCollectionSourceWork(context: WorkContext): Promise<void>;
export { IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION, declareLibraryIdentityStatement, assembleLibraryIdentityOriginalComponents, LIBRARY_IDENTITY_CHECKOUT_WORK, LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS, assembleLibraryIdentitySelectedBodies, LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES, LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS, } from './identity-original-work.ts';
