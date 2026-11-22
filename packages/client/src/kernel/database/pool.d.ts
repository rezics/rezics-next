import { type Pool, type PoolClient } from 'pg';
import { type BoundedReadLifetimeOptions } from './bounded-read-lifetime.ts';
export { partitionReadClient, partitionReadClientObservation, partitionReadClients } from './read-snapshot.ts';
export { boundedReadWindow } from './bounded-read-window.ts';
export { BoundedReadDeadlineError, isPostgresTransactionAbort, RetiredReadClientError, type NativeReadQueryConfig, } from './bounded-read-lifetime.ts';
export declare const KERNEL_POOL_MAX = 10;
export declare function readPoolAcquireTimeoutMillis(env?: NodeJS.ProcessEnv): number;
export declare class NestedPoolCheckoutError extends Error {
    constructor();
}
export declare function createPool(url: string, options?: {
    connectionTimeoutMillis?: number;
    idleTimeoutMillis?: number;
    min?: number;
}): Pool;
/** Accounting only: the executor retains its original client and cleanup custody. */
export type QueryAccounting = Readonly<{
    query<T>(sql: string, operands: readonly unknown[], dispatch: () => Promise<T>): Promise<T>;
    connection<T>(dispatch: () => Promise<T>): Promise<T>;
}>;
export declare function withQueryAccounting<T>(accounting: QueryAccounting, run: () => Promise<T>): Promise<T>;
/** An owner with its own query meter returns its measured cost to the caller. */
export declare function withoutQueryAccounting<T>(run: () => Promise<T>): Promise<T>;
export declare function withConnection<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>;
type BoundedReadOptions = Omit<BoundedReadLifetimeOptions, 'transaction' | 'mode'>;
export declare function hasPretransactionReadSession(pool: Pool): boolean;
/** Before writer BEGIN, bounded native point reads on this exact pool may use
 * the already leased backend. Distinct pools keep their own checkout custody. */
export declare function withPretransactionReads<T>(pool: Pool, client: PoolClient, prepare: () => Promise<T>): Promise<T>;
/** Opt in to one finite physical checkout for native read work. */
export declare function withBoundedReadConnection<T>(pool: Pool, deadline: number, read: (client: PoolClient) => Promise<T>, options?: BoundedReadOptions): Promise<T>;
/** Lease one backend for successive, separately committed native read-only snapshots. */
export declare function withBoundedIndependentReads<T>(pool: Pool, deadline: number, read: () => Promise<T>, options?: BoundedReadOptions): Promise<T>;
/** Bound a native transaction without changing the identity of its original Pool. */
export declare function withBoundedCommandConnection<T>(pool: Pool, deadline: number, work: (client: PoolClient) => Promise<T>, options?: BoundedReadOptions): Promise<T>;
/** Opt in to a finite read-only repeatable-read transaction on one checkout. */
export declare function withBoundedReadOnlyTransaction<T>(pool: Pool, deadline: number, read: (client: PoolClient) => Promise<T>, options?: BoundedReadOptions): Promise<T>;
export declare function discardConnection(client: PoolClient, error: Error): void;
/** Error-release closes an uncertain pg session while its original callback still drains. */
export declare function retireConnection(client: PoolClient, error: Error): void;
