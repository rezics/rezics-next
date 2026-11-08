import type { Pool } from 'pg';
import type { AccessClient } from '../../request/access.ts';
import { type FollowCountHealthObservation } from '../contract/index.ts';
export type { FollowCountHealthObservation } from '../contract/index.ts';
/** Constant root metadata in the caller's native snapshot. No partition/follower scan. */
export declare function readFollowCountHealthObservation(tx: AccessClient): Promise<FollowCountHealthObservation>;
/** Constant root metadata at each end of a private read. No partition/follower scan. */
export declare function requireFollowCountHealth(pool: Pool): Promise<FollowCountHealthObservation>;
