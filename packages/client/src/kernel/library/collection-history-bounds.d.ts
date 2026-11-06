/** Immutable nine-axis declarations for the existing Collection metadata journal SQL. */
import { type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
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
type QueryClient = Pick<PoolClient, 'query'>;
export type CollectionMetadataHistorySqlPlan<Input = unknown> = Readonly<{
    kind: string;
    input: Readonly<Input>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryInitializePlan(input: {
    route: number;
    collection: Readonly<{
        id: string;
        curatorAccountId: string;
    }>;
    transactionId: string;
    time: string;
}): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        transaction_id: string;
        updated_at: string;
    }>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export type CollectionMetadataHistoryCapturePlan = Readonly<{
    kind: 'collection.metadata-history.no-change' | 'collection.metadata-history.capture';
    input: Readonly<{
        route: number;
        before: CollectionMetadataSnapshotInput;
        after: CollectionMetadataSnapshotInput;
        collectionId: string;
        curatorAccountId: string;
        revision: number;
        transactionId: string;
        time: string;
    }>;
    changedFields: readonly CollectionMetadataFieldInput[];
    leaves: Readonly<{
        owner?: CollectionMetadataHistorySqlPlan;
        append?: CollectionMetadataHistorySqlPlan;
        prune?: CollectionMetadataHistorySqlPlan;
        pruned?: CollectionMetadataHistorySqlPlan;
    }>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryCapturePlan(input: {
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
}): CollectionMetadataHistoryCapturePlan;
export declare function collectionMetadataHistoryStatePlan(input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
}): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
    }>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryPagePlan(input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
    afterRevision: number | null;
    limit: number;
}): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        after_revision: number | null;
        page_limit: number;
    }>;
    total: Bound;
    withinExistingCeiling: boolean;
}>;
export declare function collectionMetadataHistoryEntryPlan(input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
    revision: number;
}): Readonly<{
    kind: string;
    input: Readonly<{
        route: number;
        collection_id: string;
        curator_account_id: string;
        revision: number;
    }>;
    total: Bound;
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
export {};
