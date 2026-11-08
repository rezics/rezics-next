import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type FeedActivityTarget = Readonly<{
    type: 'subject' | 'collection' | 'space';
    id: string;
}>;
export type FeedActivityObject = Readonly<{
    owner: 'content';
    kind: 'thread' | 'post';
    route: number;
    id: string;
    threadId: string;
}> | Readonly<{
    owner: 'semantic';
    kind: string;
    route: number;
    id: string;
    realmId: string;
    publicationId: string;
}> | Readonly<{
    owner: 'library';
    kind: 'collection';
    route: number;
    id: string;
}>;
export type ActivityRef = Readonly<{
    id: string;
    source: Readonly<{
        partition: number;
        epoch: number;
        position: string;
        eventIndex: number;
    }>;
    occurredAt: string;
    target: FeedActivityTarget;
    object: FeedActivityObject;
}>;
export type ActivityPage = Readonly<{
    activities: readonly ActivityRef[];
    next: string | null;
}>;
export type ActivityPageQuery = Readonly<{
    cursor?: string;
    limit?: number;
}>;
export declare const FEED_RETENTION_MS: number;
export declare const FEED_REFERENCE_CAP = 2000;
export declare function feedRoute(id: string): number;
export declare function feedPageLimit(limit?: number): number;
export declare function validateActivity(activity: ActivityRef): void;
/** Candidate inventories carry no body, title, account permission or disclosure grant.
 * tokens is additive: exposed inventory/inbox cursors use the composed native ring. */
export declare function createFeedActivityStore(deps: {
    pool: Pool;
    clock: KernelClock;
    tokens: KeyRing;
}): {
    pageTargetActivity: (target: FeedActivityTarget, query: ActivityPageQuery, deadline: number) => Promise<Readonly<{
        activities: readonly ActivityRef[];
        next: string | null;
    }>>;
    pageFollowingActivity: (accountId: string, query: ActivityPageQuery & {
        boundary?: string;
    }, deadline: number) => Promise<Readonly<{
        activities: readonly ActivityRef[];
        next: string | null;
    }>>;
    recordTargetActivity(activity: ActivityRef, deadline: number): Promise<void>;
    applyFollowingActivity(input: {
        accountId: string;
        reasonTarget: FeedActivityTarget;
        activity: ActivityRef;
    }, deadline: number): Promise<void>;
};
export type FeedActivityStore = ReturnType<typeof createFeedActivityStore>;
/** Repeated by the existing account erasure phase; never acknowledges foreign or Library stores. */
export declare function eraseFeedInboxPage(pool: Pool, accountId: string, deadline: number): Promise<number>;
