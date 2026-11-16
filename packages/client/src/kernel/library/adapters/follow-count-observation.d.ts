import type { Pool } from 'pg';
import type { AccessClient } from '../../request/access.ts';
import { type FollowCountHealthObservation } from '../contract/index.ts';
export type { FollowCountHealthObservation } from '../contract/index.ts';
/** Constant root metadata in the caller's native snapshot. No partition/follower scan. */
export declare function readFollowCountHealthObservation(tx: AccessClient): Promise<FollowCountHealthObservation>;
/** Borrowed Follow reads retain the original deadline through checkout and every query.
 * A late checkout dispatches no SQL. A rejected callback discards its borrowed socket
 * before release. Expiry retires an active socket even when the read callback
 * has yet to settle. */
export declare function withFollowCountReadConnection<T>(pool: Pool, deadline: number, read: (client: AccessClient) => Promise<T>): Promise<T>;
export declare function requireFollowCountHealth(pool: Pool, deadline: number): Promise<FollowCountHealthObservation>;
