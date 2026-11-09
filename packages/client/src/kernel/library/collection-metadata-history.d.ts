import type { PoolClient } from 'pg';
import type { Collection, CollectionDraft } from './collection-model.ts';
import { COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, COLLECTION_METADATA_HISTORY_PAGE_SIZE } from './collection-history-bounds.ts';
type Client = Pick<PoolClient, 'query'>;
export { COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, COLLECTION_METADATA_HISTORY_PAGE_SIZE, };
export { COLLECTION_METADATA_FIELDS } from './contract/index.ts';
export type { CollectionMetadataField, CollectionMetadataHistoryCoverage, CollectionMetadataSnapshot, CollectionMetadataHistoryEntry, CollectionMetadataHistoryBasis, CollectionMetadataHistoryPageItem, CollectionMetadataHistoryPage, CollectionMetadataHistoryCover, CollectionMetadataHistorySnapshot, CollectionMetadataHistoryDetail, CollectionMetadataHistoryState, } from './contract/index.ts';
import { type CollectionMetadataField, type CollectionMetadataHistoryEntry, type CollectionMetadataHistoryState } from './contract/index.ts';
export declare function initializeCollectionMetadataHistory(client: Client, input: {
    route: number;
    collection: Pick<CollectionDraft, 'id' | 'curatorAccountId'>;
    transactionId: string;
    time: string;
}, plan?: Readonly<{
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
}>): Promise<void>;
/** Capture one committed metadata transition; replay and no-op metadata commands add no row. */
export declare function captureCollectionMetadataHistory(client: Client, input: {
    route: number;
    before: Collection;
    after: Collection;
    transactionId: string;
    time: string;
}, plan?: Readonly<{
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
        owner?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        append?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        prune?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        pruned?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
    }>;
    total: import("./access-capabilities.ts").WorkDimensions & Readonly<{
        engineRequests: number;
    }>;
    withinExistingCeiling: boolean;
}>): Promise<void>;
export declare function readCollectionMetadataHistoryState(client: Client, input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
}, plan?: Readonly<{
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
}>): Promise<CollectionMetadataHistoryState>;
export declare function pageCollectionMetadataHistory(client: Client, input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
    afterRevision: number | null;
    limit: number;
}, plan?: Readonly<{
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
}>): Promise<{
    revision: number;
    transactionId: string;
    recordedAt: string;
    changedFields: (string | null)[];
}[]>;
export declare function collectionMetadataHistoryFields(value: readonly (string | null)[]): CollectionMetadataField[];
export declare function readCollectionMetadataHistoryEntry(client: Client, input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
    revision: number;
}, plan?: Readonly<{
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
}>): Promise<{
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
export declare function collectionMetadataHistoryEntry(row: {
    revision: number;
    transactionId: string;
    recordedAt: string;
    changedFields: readonly (string | null)[];
    beforeTitle: string;
    afterTitle: string;
    beforeDescription: string | null;
    afterDescription: string | null;
    beforeVisibility: string;
    afterVisibility: string;
    beforePresentationKind: string | null;
    afterPresentationKind: string | null;
    beforeCoverMediaId: string | null;
    afterCoverMediaId: string | null;
}): CollectionMetadataHistoryEntry;
