import type { Collection } from './collection.ts';
import type { LibraryCoverSummary } from './capabilities.ts';
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
    summary: LibraryCoverSummary;
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
export type CollectionMetadataHistoryState = {
    coverage: CollectionMetadataHistoryCoverage;
    knownFromRevision: number | null;
    prunedBeforeRevision: number | null;
};
