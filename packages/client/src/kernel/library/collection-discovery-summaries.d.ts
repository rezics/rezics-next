import { type CollectionDiscoveryContext, type CollectionCurator } from './collection-discovery-context.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import { type CollectionPresentation, type PresentationDependencies } from './collection-presentation.ts';
import type { CollectionDiscoveryQuery, CollectionDiscoveryRecency, CollectionPresentationKind } from './collection-discovery-source.ts';
export declare const MAX_COLLECTION_DISCOVERY_SUMMARIES = 100;
export type PublicCollectionDiscoveryContext = Readonly<{
    actor: Actor;
    /** The single native owner partition, not an index partition or an inferred actor home. */
    partition: number;
    deadline: number;
    /** Borrowed native read time. Hydration never releases a caller-owned capability. */
    time?: AuthoritativeTime;
    languages?: readonly string[];
}>;
export type PublicCollectionDiscoveryRequest = Readonly<{
    ids: readonly string[];
    context: PublicCollectionDiscoveryContext;
}>;
type Card = Omit<CollectionPresentation, 'coverMediaId'> & CollectionDiscoveryContext & Readonly<{
    kind: 'collection';
    id: string;
    destination: `/collections/${string}`;
    title: string;
    description: string | null;
    visibility: 'public';
    revision: number;
    sourceGeneration: string;
}>;
export type PublicCollectionDiscoverySummary = Card & (Readonly<{
    membershipKind: 'curated';
    memberCount: number;
    orderEpoch: number;
    createdAt: string;
    updatedAt: string;
}> | Readonly<{
    membershipKind: 'dynamic';
    outputGeneration: string;
}>);
export type PublicCollectionDiscoveryOperand = Readonly<{
    id: string;
    presentationKind: CollectionPresentationKind;
    curator: CollectionCurator;
    subjectMembership: Readonly<{
        state: 'available';
        subjectId: string;
        matches: boolean;
    }> | Readonly<{
        state: 'withheld';
    }> | null;
    popularity: Readonly<{
        followers: string;
    }> | null;
    recency: CollectionDiscoveryRecency;
    eligible: Readonly<{
        presentationKind: boolean | null;
        curator: boolean | null;
        subject: boolean | null;
    }>;
}>;
export type PublicCollectionDiscoveryResult = Readonly<{
    state: 'ready';
    summaries: readonly PublicCollectionDiscoverySummary[];
    operands: readonly PublicCollectionDiscoveryOperand[];
    queryObservation: string;
}> | Readonly<{
    state: 'unavailable';
    reason: 'native_authority' | 'changed' | 'access' | 'partition' | 'deadline' | 'follow_count';
}>;
export type PublicCollectionDiscoveryDependencies = PresentationDependencies;
/** One deduplicated native batch, followed by fresh authority and version revalidation. The result
 * contains each still-readable identity at most once, in first-requested order. Unavailability
 * never returns a partial card list; legitimate missing/denied/withdrawn candidates are omitted.
 */
export declare function readPublicCollectionDiscoverySummaries(dependencies: PublicCollectionDiscoveryDependencies, ids: readonly string[], context: PublicCollectionDiscoveryContext, query?: CollectionDiscoveryQuery): Promise<PublicCollectionDiscoveryResult>;
export {};
