import type { DurableOperationAnchor } from './durable-initiator.ts';
import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
export type WriteRateFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';
export type AccountRateClass = 'anonymous' | 'new-account' | 'member' | 'trusted' | 'service';
export type WriteRateContext = {
    pool: Pool;
    actor: Actor;
    deadline: number;
};
/** retryAfter is the delay in seconds before retrying a refused spend. */
export type WriteRateDecision = {
    allowed: true;
} | {
    allowed: false;
    retryAfter: number;
};
/** Request-stage admission only; success never confers authorization.
 * A bulk reserves all native command units once, before any command runs.
 */
export type WriteRateLimiter = {
    /** units defaults to 1 and must be a positive safe integer no greater than 100. */
    spend(context: WriteRateContext, family: WriteRateFamily, units?: number): Promise<WriteRateDecision>;
};
export type WriteRateChunk = Readonly<{
    operation: DurableOperationAnchor;
    index: number;
}>;
export type DurableWriteRateLimiter = WriteRateLimiter & {
    /** Call in CommandAuthorization.prepare after restoring the initiator at the same T.
     * Retries of the same identity/operation/index spend nothing within the window.
     */
    spendChunk(context: WriteRateContext, chunk: WriteRateChunk, family: WriteRateFamily, units: number): Promise<WriteRateDecision>;
};
export declare class WriteRateUnavailableError extends Error {
    constructor();
}
export type WriteRateConfig = {
    /** Deployment secret, at least 32 bytes. Never supplied by a request. */
    secret?: string;
    /** Strict partial RATE_LIMIT_V1 overrides encoded as JSON. */
    overrides?: string;
};
/** One native routed statement per spend; no classification query or sweep. */
export declare function createWriteRateLimiter(config?: WriteRateConfig): DurableWriteRateLimiter;
