import type { Pool } from 'pg';
export type Freshness = {
    asOf: Date;
    behind: number;
    catchingUp: boolean;
};
/** Absolute caller deadline; omission inherits request time or admits ten seconds at the call. */
export type FreshnessReadContext = Readonly<{
    deadline: number;
}>;
export declare function readFreshness(pool: Pool, consumer: string, context?: FreshnessReadContext): Promise<Freshness>;
/**
 * Answers each `current()` call from a read that began after the call. At most one read runs; calls made while it runs
 * share the next read, which begins after the running one retires. Every caller keeps its admission deadline;
 * the physical read uses the latest deadline in its batch, fixed before checkout.
 */
export declare function createFreshness(pool: Pool, consumer: string): {
    current(context?: FreshnessReadContext): Promise<Freshness>;
};
