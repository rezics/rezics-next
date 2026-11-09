/** Immutable nine-axis declarations for the existing Collection metadata journal SQL. */
import type { PoolClient } from 'pg';
type QueryClient = Pick<PoolClient, 'query'>;
import { createCollectionHistoryPlans } from './core/index.ts';
import type { CollectionMetadataHistorySqlPlan } from './contract/index.ts';
export { COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_PAGE_SIZE, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, } from './core/index.ts';
export type { CollectionMetadataSnapshotInput, CollectionMetadataFieldInput } from './core/index.ts';
export type { CollectionMetadataHistorySqlPlan, CollectionMetadataHistoryCapturePlan } from './contract/index.ts';
export declare function collectionMetadataHistoryInitializePlan(input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryInitializePlan']>[0]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        transaction_id: string;
        updated_at: string;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryCapturePlan(input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryCapturePlan']>[0]): Readonly<{
    kind: 'collection.metadata-history.no-change' | 'collection.metadata-history.capture';
    input: Readonly<{
        route: number;
        before: import("./collection-metadata-history.ts").CollectionMetadataSnapshot;
        after: import("./collection-metadata-history.ts").CollectionMetadataSnapshot;
        collectionId: string;
        curatorAccountId: string;
        revision: number;
        transactionId: string;
        time: string;
    }>;
    changedFields: readonly ("coverMediaId" | "description" | "presentationKind" | "title" | "visibility")[];
    leaves: Readonly<{
        owner?: CollectionMetadataHistorySqlPlan;
        append?: CollectionMetadataHistorySqlPlan;
        prune?: CollectionMetadataHistorySqlPlan;
        pruned?: CollectionMetadataHistorySqlPlan;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryStatePlan(input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryStatePlan']>[0]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryPagePlan(input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryPagePlan']>[0]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        after_revision: number | null;
        page_limit: number;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryEntryPlan(input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryEntryPlan']>[0]): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        revision: number;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>;
export declare function executeCollectionMetadataHistoryInitialize(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    collectionId: string;
} | null>;
export declare function executeCollectionMetadataHistoryOwner(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    collectionId: string;
}[]>;
export declare function executeCollectionMetadataHistoryAppend(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    revision: number;
}[]>;
export declare function executeCollectionMetadataHistoryPrune(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    revision: number;
}[]>;
export declare function executeCollectionMetadataHistoryPruned(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    collectionId: string;
}[]>;
export declare function executeCollectionMetadataHistoryState(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    coverage: "complete" | "partial" | "unknown";
    knownFromRevision: number;
    prunedBeforeRevision: number | null;
} | null>;
export declare function executeCollectionMetadataHistoryPage(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    revision: number;
    transactionId: string;
    recordedAt: string;
    changedFields: (string | null)[];
}[]>;
export declare function executeCollectionMetadataHistoryEntry(client: QueryClient, plan: CollectionMetadataHistorySqlPlan): Promise<{
    revision: number;
    transactionId: string;
    recordedAt: string;
    changedFields: (string | null)[];
    beforeTitle: string;
    afterTitle: string;
    beforeDescription: string | null;
    afterDescription: string | null;
    beforeVisibility: "private" | "unlisted" | "public";
    afterVisibility: "private" | "unlisted" | "public";
    beforePresentationKind: string | null;
    afterPresentationKind: string | null;
    beforeCoverMediaId: string | null;
    afterCoverMediaId: string | null;
} | null>;
