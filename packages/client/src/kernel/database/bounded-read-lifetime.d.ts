import type { PoolClient, QueryArrayConfig, QueryConfig } from 'pg';
/** QueryConfig extensions for pg's runtime timeout and array-result options. */
export type NativeReadQueryConfig<I = unknown[]> = QueryConfig<I> & {
    query_timeout?: number;
    rowMode?: 'array';
};
export type NativeReadQueryArrayConfig<I = unknown[]> = QueryArrayConfig<I> & {
    query_timeout?: number;
};
export declare class BoundedReadDeadlineError extends Error {
    constructor();
}
export declare class RetiredReadClientError extends Error {
    constructor();
}
export type BoundedReadLifetimeOptions = Readonly<{
    transaction?: 'repeatable-read-read-only';
    mode?: 'command';
    /** The checkout owns session state which must be restored before reuse. */
    discardOnExpiry?: boolean;
    /** A sequence may have a shorter original deadline for acquiring its first backend. */
    checkoutDeadline?: number;
    deadlineError?: () => Error;
    mapError?: (error: unknown) => unknown;
    isUncertainError?: (error: unknown) => boolean;
    isUncertainSettledQueryError?: (error: unknown) => boolean;
    isUncertainWorkError?: (error: unknown) => boolean;
    onRetire?: () => void;
}>;
type Checkout = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Discard = (client: PoolClient, error: Error) => void;
/** A nested owner can request disposal without taking over physical release. */
export declare function discardBoundedReadLease(client: PoolClient, error: Error): boolean;
export declare function isPostgresServerError(error: unknown): error is {
    code: string;
    severity: 'ERROR';
};
/** Native serialization and deadlock errors confirm rollback, including at COMMIT. */
export declare function isPostgresTransactionAbort(error: unknown): boolean;
/** Apply one deadline to checkout, native queries, callback work and transaction cleanup. */
export declare function withBoundedReadLifetime<T>(checkout: Checkout, discardConnection: Discard, deadline: number, read: (client: PoolClient) => Promise<T>, options?: BoundedReadLifetimeOptions): Promise<T>;
export {};
