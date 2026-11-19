/** Pure plans over producer-measured statement sizes. No SQL loader or runtime adapter is evaluated here. */
import { type Bound } from '@rezics/bounds';
import type { CollectionMetadataHistoryCapturePlan } from '../contract/index.ts';
export declare const COLLECTION_METADATA_HISTORY_LIMIT = 128;
export declare const COLLECTION_METADATA_HISTORY_PAGE_SIZE = 25;
export declare const COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE = 50;
export type CollectionMetadataSnapshotInput = Readonly<{
    title: string;
    description: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    presentationKind: string | null;
    coverMediaId: string | null;
}>;
export type CollectionMetadataFieldInput = 'title' | 'description' | 'visibility' | 'presentationKind' | 'coverMediaId';
export type CollectionHistoryStatementSizes = Readonly<Record<'append' | 'init' | 'owner' | 'page' | 'prune' | 'pruned' | 'read' | 'state', Readonly<{
    bytes: number;
}>>>;
export declare function createCollectionHistoryPlans(statements: CollectionHistoryStatementSizes, ceiling: Bound): {
    collectionMetadataHistoryInitializePlan: (input: {
        route: number;
        collection: Readonly<{
            id: string;
            curatorAccountId: string;
        }>;
        transactionId: string;
        time: string;
    }) => Readonly<{
        kind: string;
        input: Readonly<{
            route: number;
            collection_id: string;
            curator_account_id: string;
            transaction_id: string;
            updated_at: string;
        }>;
        total: import("../collection-source.ts").WorkDimensions & Readonly<{
            engineRequests: number;
        }>;
        withinExistingCeiling: boolean;
    }>;
    collectionMetadataHistoryCapturePlan: (input: {
        route: number;
        before: CollectionMetadataSnapshotInput & Readonly<{
            id: string;
        }>;
        after: CollectionMetadataSnapshotInput & Readonly<{
            id: string;
            curatorAccountId: string | null;
            revision: number;
        }>;
        transactionId: string;
        time: string;
    }) => CollectionMetadataHistoryCapturePlan;
    collectionMetadataHistoryStatePlan: (input: {
        route: number;
        collectionId: string;
        curatorAccountId: string;
    }) => Readonly<{
        kind: string;
        input: Readonly<{
            route: number;
            collection_id: string;
            curator_account_id: string;
        }>;
        total: import("../collection-source.ts").WorkDimensions & Readonly<{
            engineRequests: number;
        }>;
        withinExistingCeiling: boolean;
    }>;
    collectionMetadataHistoryPagePlan: (input: {
        route: number;
        collectionId: string;
        curatorAccountId: string;
        afterRevision: number | null;
        limit: number;
    }) => Readonly<{
        kind: string;
        input: Readonly<{
            route: number;
            collection_id: string;
            curator_account_id: string;
            after_revision: number | null;
            page_limit: number;
        }>;
        total: import("../collection-source.ts").WorkDimensions & Readonly<{
            engineRequests: number;
        }>;
        withinExistingCeiling: boolean;
    }>;
    collectionMetadataHistoryEntryPlan: (input: {
        route: number;
        collectionId: string;
        curatorAccountId: string;
        revision: number;
    }) => Readonly<{
        kind: string;
        input: Readonly<{
            route: number;
            collection_id: string;
            curator_account_id: string;
            revision: number;
        }>;
        total: import("../collection-source.ts").WorkDimensions & Readonly<{
            engineRequests: number;
        }>;
        withinExistingCeiling: boolean;
    }>;
};
