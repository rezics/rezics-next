import type { Pool, PoolClient } from 'pg';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';
/** Private accounting only. SQL/API owners supply the proved footprint before dispatch. */
export declare class NativeCollectionWork {
    private readonly allowance;
    private readonly deadline;
    private readonly used;
    private readonly held;
    private readonly remaining;
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
    /** Transfer the remaining reservation to ONE existing producer ledger, never a second allowance.
     * The parent cannot dispatch while it is held. Unlike an SQL footprint this is not itself native work:
     * the child reserves its actual operation bounds before dispatch and returns those charges unchanged.
     */
    compose<T extends {
        readonly work: WorkReceipt;
    }>(operation: (allowance: WorkAllowance) => Promise<T>, ceiling?: WorkDimensions): Promise<T>;
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
/** Observe the original pool/clients: no shadow pool, client proxy or identity/time registration changes. */
export declare function instrumentNativeCollectionWork<T>(pool: Pool, work: NativeCollectionWork, footprint: Footprint, operation: () => Promise<T>, client?: PoolClient): Promise<T>;
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
export {};
