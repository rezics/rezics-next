/** Private bounded follow preparation shared by Search and Space entry. The writer remains follows.ts. */
import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
export type FollowDiscoveryTarget = Readonly<{
    targetId: string;
    targetType: 'subject' | 'collection' | 'space';
    source: string;
}>;
export type FollowDiscoveryRow = FollowDiscoveryTarget & Readonly<{
    following: boolean;
    actions: Readonly<{
        follow: boolean;
        unfollow: boolean;
    }>;
}>;
export type FollowDiscovery = Readonly<{
    state: 'signed-out';
}> | Readonly<{
    state: 'unavailable';
    reason: 'identity' | 'changed' | 'native';
}> | Readonly<{
    state: 'current';
    accountId: string;
    partition: number;
    rows: readonly FollowDiscoveryRow[];
}>;
export type FollowDiscoveryDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock?: KernelClock;
}>;
/** Targets must come from the composing owner's final public disclosure, never from a public index.
 * The account partition is derived only from the authenticated actor. No target-home inference.
 */
export declare function readFollowDiscovery(dependencies: FollowDiscoveryDependencies, actor: Actor, targets: readonly FollowDiscoveryTarget[], deadline: number): Promise<FollowDiscovery>;
