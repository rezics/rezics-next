import type { Pool } from 'pg';
import type { AccessClient } from '../../request/access.ts';
import { deadlineClient, within } from '../access-port.ts';
import { type FollowCountHealthObservation } from '../contract/index.ts';
export type { FollowCountHealthObservation } from '../contract/index.ts';
/** Constant root metadata in the caller's native snapshot. No partition/follower scan. */
export declare function readFollowCountHealthObservation(tx: AccessClient): Promise<FollowCountHealthObservation>;
/** Borrowed Follow reads retain the original deadline through checkout and every query.
 * A late checkout dispatches no SQL. A rejected callback discards its borrowed socket
 * before release so an open transaction is cleaned up without queuing rollback behind
 * uncertain native IO. Caller-owned snapshots keep their existing lifetime. */
export declare function withFollowCountReadConnection<T>(pool: Pool, deadline: number, read: (client: AccessClient) => Promise<T>, timing?: {
    deadlineClient: typeof deadlineClient;
    within: typeof within;
}): Promise<T>;
export declare function requireFollowCountHealth(pool: Pool, deadline: number): Promise<FollowCountHealthObservation>;
