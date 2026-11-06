import { type Pool, type PoolClient } from 'pg';
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
export declare function withConnection<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>;
export declare function discardConnection(client: PoolClient, error: Error): void;
