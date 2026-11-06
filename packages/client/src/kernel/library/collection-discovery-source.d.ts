/** Native indexing hints only. Current viewer hydration is a separate Commerce boundary. */
import type { Pool } from 'pg';
import { type FollowCountHealthObservation } from './follow-count-health.ts';
import type { CollectionOutputRef } from './collection-source-output.ts';
export type CollectionDiscoveryKey = Readonly<{
    route: number;
    id: string;
}>;
/** The existing public-listing stamp, observed in the same native snapshot as the values. */
export type CollectionDiscoveryPosition = Readonly<{
    partition: number;
    epoch: number;
    position: string;
    followCountHealth?: FollowCountHealthObservation;
}>;
export type CollectionPresentationKind = Readonly<{
    kind: 'mixed';
} | {
    kind: 'owner';
    id: string;
}>;
export type CollectionDiscoveryRecency = readonly [updatedAtEpochMicros: string | null, route: number, id: string];
export type CollectionDiscoveryQuery = Readonly<{
    presentationKind?: CollectionPresentationKind;
    curatorAccountId?: string;
    subjectId?: string;
    popularity?: boolean;
    order?: 'identity' | 'popularity' | 'recency';
}>;
export type CollectionDiscoveryReadContext = Readonly<{
    deadline: number;
}>;
export type CollectionDiscoveryOperands = Readonly<{
    presentationKind: CollectionPresentationKind;
    subjectMembership: Readonly<{
        subjectId: string;
        matches: boolean;
    }> | null;
    popularity: Readonly<{
        followers: string;
    }> | null;
    recency: CollectionDiscoveryRecency;
}>;
export type CollectionDiscoveryIndexableValue = Readonly<{
    kind: 'collection';
    key: CollectionDiscoveryKey;
    revision: number;
    title: string;
    description: string | null;
    presentationKind: string | null;
    coverMediaId: string | null;
    operands: CollectionDiscoveryOperands;
}> & ({
    membershipKind: 'curated';
    output: null;
} | {
    membershipKind: 'dynamic';
    output: CollectionOutputRef;
});
export type CollectionDiscoveryItem = Readonly<{
    key: CollectionDiscoveryKey;
}> & ({
    status: 'indexable';
    value: CollectionDiscoveryIndexableValue;
} | {
    status: 'withdrawn';
} | {
    status: 'unavailable';
    reason: 'selected_publication_witness_unavailable';
});
export type CollectionDiscoverySnapshot = Readonly<{
    status: 'available';
    stamp: CollectionDiscoveryPosition;
    items: readonly CollectionDiscoveryItem[];
}> | Readonly<{
    status: 'unavailable';
    reason: 'native_partition_unavailable' | 'follow_count_unavailable';
}>;
export type CollectionDiscoveryPage = CollectionDiscoverySnapshot & Readonly<{
    next: CollectionDiscoveryKey | null;
}>;
export type CollectionDiscoveryCensus = Readonly<{
    status: 'unavailable';
    reason: 'native_collection_population_evidence_unavailable';
}>;
export type CollectionDiscoverySource = Readonly<{
    read(partition: number, ids: readonly CollectionDiscoveryKey[], query?: CollectionDiscoveryQuery, context?: CollectionDiscoveryReadContext): Promise<CollectionDiscoverySnapshot>;
    page(partition: number, after: CollectionDiscoveryKey | null, limit: number, query?: CollectionDiscoveryQuery, context?: CollectionDiscoveryReadContext): Promise<CollectionDiscoveryPage>;
    count(partition: number): Promise<CollectionDiscoveryCensus>;
}>;
/** No projection, clock or authorization is owned here. Deliveries must reread current native truth;
 * consumers order replacements/withdrawals by (stamp.epoch, BigInt(stamp.position)), never event arrival.
 */
export declare function publicCollectionDiscoverySource({ pool }: {
    pool: Pool;
}): CollectionDiscoverySource;
