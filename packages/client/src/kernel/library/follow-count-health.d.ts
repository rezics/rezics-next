import type { AccessClient } from '../request/access.ts';
import type { Pool } from 'pg';
import { type CountRuntime } from './follow-count-source.ts';
export type FollowCountHealthObservation = Readonly<{
    sampledAt: string;
    oldestPendingAt: string | null;
    consumerObservedAt: string;
    consumerOldestPendingAt: string | null;
}>;
/** One native partition sample, three bounded 16-child reductions. Stale children
 * retain their timestamp; a parent cannot refresh it by running again. */
export declare function sampleFollowCountHealth(deps: CountRuntime, partition: number): Promise<void>;
/** Constant root metadata in the caller's native snapshot. No partition/follower scan. */
export declare function readFollowCountHealthObservation(tx: AccessClient): Promise<FollowCountHealthObservation>;
/** Constant root metadata at each end of a private read. No partition/follower scan. */
export declare function requireFollowCountHealth(pool: Pool): Promise<FollowCountHealthObservation>;
