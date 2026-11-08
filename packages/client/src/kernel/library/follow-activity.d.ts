import type { Pool } from 'pg';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
import { type KernelClock } from '../clock.ts';
import type { Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { FeedActivityStore, FeedActivityTarget } from '../content/feed-activity.ts';
export type FollowActivitySupport = Readonly<{
    target: FeedActivityTarget;
    status: 'following' | 'not_following' | 'unavailable';
}>;
export type FollowRecipientPage = Readonly<{
    recipients: readonly {
        accountId: string;
    }[];
    next: string | null;
}>;
/** The inverse is only a candidate source. Every positive comes from an independent actor-home
 * follow read and current identity check; an incomplete redirected source never certifies absence. */
export declare function createFollowActivitySource(deps: {
    pool: Pool;
    clock?: KernelClock;
    tokens: KeyRing;
    workClient: WorkClient;
    activityStore: FeedActivityStore;
    semanticObservations?: LibrarySemanticObservationCapability;
}): {
    pageRecipients(target: FeedActivityTarget, query: {
        cursor?: string;
        limit?: number;
    }, deadline: number): Promise<FollowRecipientPage>;
    checkCurrentFollowSupport(actor: Actor, input: {
        targets: readonly FeedActivityTarget[];
    }, deadline: number): Promise<readonly FollowActivitySupport[]>;
};
export type FollowActivitySource = ReturnType<typeof createFollowActivitySource>;
