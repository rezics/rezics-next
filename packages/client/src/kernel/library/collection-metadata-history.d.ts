import type { PoolClient } from 'pg';
import type { Collection, CollectionDraft } from './collection-model.ts';
import type { CoverSummary } from '../semantic/summaries.ts';
import { COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, COLLECTION_METADATA_HISTORY_PAGE_SIZE } from './collection-history-bounds.ts';
type Client = Pick<PoolClient, 'query'>;
export { COLLECTION_METADATA_HISTORY_LIMIT, COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE, COLLECTION_METADATA_HISTORY_PAGE_SIZE, };
export declare const COLLECTION_METADATA_FIELDS: readonly ['title', 'description', 'visibility', 'presentationKind', 'coverMediaId'];
export type CollectionMetadataField = (typeof COLLECTION_METADATA_FIELDS)[number];
export type CollectionMetadataHistoryCoverage = 'complete' | 'partial' | 'unknown';
export type CollectionMetadataSnapshot = Pick<Collection, 'title' | 'description' | 'visibility' | 'presentationKind' | 'coverMediaId'>;
export type CollectionMetadataHistoryEntry = {
    revision: number;
    transactionId: string;
    recordedAt: string;
    changedFields: CollectionMetadataField[];
    before: CollectionMetadataSnapshot;
    after: CollectionMetadataSnapshot;
};
export type CollectionMetadataHistoryBasis = {
    collectionRevision: number;
    curatorAccountId: string;
    viewerAccountId: string;
    authnEpoch: number;
    minimumAuthnEpoch: string;
};
export type CollectionMetadataHistoryPageItem = Pick<CollectionMetadataHistoryEntry, 'revision' | 'recordedAt' | 'changedFields'>;
export type CollectionMetadataHistoryPage = {
    collectionId: string;
    basis: CollectionMetadataHistoryBasis;
    coverage: CollectionMetadataHistoryState;
    items: CollectionMetadataHistoryPageItem[];
    next: string | null;
    actions: {
        review: true;
        reapply: false;
    };
};
export type CollectionMetadataHistoryCover = {
    state: 'none';
} | {
    state: 'unavailable';
} | {
    state: 'available';
    mediaId: string;
    summary: CoverSummary;
};
export type CollectionMetadataHistorySnapshot = Omit<CollectionMetadataSnapshot, 'coverMediaId'> & {
    cover: CollectionMetadataHistoryCover;
};
export type CollectionMetadataHistoryDetail = {
    collectionId: string;
    revision: number;
    recordedAt: string;
    changedFields: CollectionMetadataField[];
    before: CollectionMetadataHistorySnapshot;
    after: CollectionMetadataHistorySnapshot;
    basis: CollectionMetadataHistoryBasis;
    actions: {
        review: true;
        reapply: false;
    };
};
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
    total: import("@rezics/bounds").Bound;
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
        before: import("./collection-history-bounds.ts").CollectionMetadataSnapshotInput;
        after: import("./collection-history-bounds.ts").CollectionMetadataSnapshotInput;
        collectionId: string;
        curatorAccountId: string;
        revision: number;
        transactionId: string;
        time: string;
    }>;
    changedFields: readonly import("./collection-history-bounds.ts").CollectionMetadataFieldInput[];
    leaves: Readonly<{
        owner?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        append?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        prune?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
        pruned?: import("./collection-history-bounds.ts").CollectionMetadataHistorySqlPlan;
    }>;
    total: import("@rezics/bounds").Bound;
    withinExistingCeiling: boolean;
}>): Promise<void>;
export type CollectionMetadataHistoryState = {
    coverage: CollectionMetadataHistoryCoverage;
    knownFromRevision: number | null;
    prunedBeforeRevision: number | null;
};
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
    total: import("@rezics/bounds").Bound;
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
    total: import("@rezics/bounds").Bound;
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
    total: import("@rezics/bounds").Bound;
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
