import type { Pool } from 'pg';
export type Freshness = {
    asOf: Date;
    behind: number;
    catchingUp: boolean;
};
export declare function readFreshness(pool: Pool, consumer: string): Promise<Freshness>;
/**
 * Answers each `current()` call from a read that began after the call. At most one read runs; calls made while it runs
 * share the next read, which begins when the running one settles.
 */
export declare function createFreshness(pool: Pool, consumer: string): {
    current(): Promise<Freshness>;
};
