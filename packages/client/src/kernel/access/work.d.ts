import { AccessUnavailableError } from './unavailable.ts';
/** Neutral native dimensions, structurally compatible with the Source ledger. */
export type AccessWork = Readonly<{
    keys: number;
    points: number;
    witnesses: number;
    rows: number;
    bytes: number;
    emptySeeks: number;
}>;
export declare const ACCESS_WORK_AXES: readonly ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'];
export declare const EMPTY_ACCESS_WORK: AccessWork;
/** Implemented by the caller's EXISTING ledger. This port owns no allowance. */
export type AccessWorkSink = Readonly<{
    reserve(operation: string, bound: AccessWork, kind: 'native' | 'owner'): Readonly<{
        settle(actual: AccessWork): void;
    }> | null;
}>;
/** Trusted resource owner: pure finite declaration, then its actual receipt.
 * `actual` must be synchronous, contain no IO, and refer to this exact invocation.
 * A missing receipt after dispatch consumes the entire bound and poisons the attempt.
 */
export type AccessWorkProducer<C, R> = Readonly<{
    bound(context: C): AccessWork | undefined;
    actual(context: C, result: R): AccessWork | undefined;
}>;
export type AccessWorkResult<T> = Readonly<{
    state: 'complete';
    value: T;
    usage: AccessWork;
}> | Readonly<{
    state: 'unavailable';
    dependency: string;
    usage: AccessWork;
}> | Readonly<{
    state: 'failed';
    error: unknown;
    usage: AccessWork;
}>;
export declare class AccessWorkUnavailableError extends AccessUnavailableError {
    readonly dependency: string;
    constructor(dependency: string);
}
export declare function addAccessWork(...values: readonly AccessWork[]): AccessWork;
/** Receipt accumulator only. Admission and remaining budget stay with the sink.
 * Dispatch charges the bound immediately, so timeout/parallel/failed work cannot
 * disappear from a caller's receipt while an operation is still unwinding.
 */
export declare class AccessWorkAccounting {
    private readonly sink;
    readonly deadline: number;
    private readonly frames;
    private used;
    private failure;
    private readonly pending;
    constructor(sink: AccessWorkSink, deadline: number);
    usage(): AccessWork;
    /** Seal unknown dispatched work before an enclosing deadline race returns. */
    fail(error: unknown): void;
    capture<T>(operation: () => Promise<T>): Promise<AccessWorkResult<T>>;
    unavailable(dependency: string): never;
    /** Exact receipt of this admitted invocation, independent of concurrent roots. */
    invocation<T>(operation: string, bound: AccessWork | undefined, dispatch: () => Promise<T>, deadline?: number): Promise<Readonly<{
        value: T;
        usage: AccessWork;
    }>>;
    run<T>(operation: string, footprint: AccessWork | undefined, dispatch: () => Promise<T>, actual?: (result: T) => AccessWork | undefined, kind?: 'native' | 'owner', notAfter?: number): Promise<T>;
}
export declare function accessOwnerWork<C, R>(work: AccessWorkAccounting | undefined, operation: string, producer: AccessWorkProducer<C, R> | undefined, context: C, dispatch: () => Promise<R>): Promise<R>;
/** Owner declarations for the explicit SQL call sites, never a SQL classifier.
 * Rows are dispatched plan work (including empty probes), NEVER result rowCount.
 * Byte reservations cover parameters and the closed projection. Only bytes and
 * the outer empty seek can settle below their bound on a completed statement.
 */
export declare function accessNativeDeclaration(operation: 'time' | 'assignment' | 'inverse' | 'membership' | 'candidates' | 'formula' | 'account-state' | 'opening' | 'opening-partition' | 'opening-moved-target' | 'transaction', input: unknown, shape: Readonly<{
    members?: number;
    groups?: number;
    targets?: number;
    roles?: number;
    grantRoles?: number;
    explicit?: boolean;
    public?: boolean;
    global?: boolean;
    assignment?: boolean;
    movedToBytes?: number;
}>): {
    bound: Readonly<{
        keys: number;
        points: number;
        witnesses: number;
        rows: number;
        bytes: number;
        emptySeeks: number;
    }>;
    actual: (result: unknown) => AccessWork;
};
export declare function accessNativeWork<T>(work: AccessWorkAccounting | undefined, operation: Parameters<typeof accessNativeDeclaration>[0], input: unknown, shape: Parameters<typeof accessNativeDeclaration>[2], dispatch: () => Promise<T>): Promise<T>;
/** Reserve before an explicit pool checkout, including its wait and failure. */
export declare function accessCheckout<T>(work: AccessWorkAccounting | undefined, dispatch: () => Promise<T>): Promise<T>;
/** Explicit transaction control; no SQL inspection or hidden queries. */
export declare function accessTransaction(work: AccessWorkAccounting | undefined, client: import('../request/access.ts').AccessClient, statement: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' | 'BEGIN READ ONLY' | 'COMMIT' | 'ROLLBACK'): Promise<void>;
