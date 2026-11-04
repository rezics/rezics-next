export type CollectionMetadataHistoryField =
  | 'title'
  | 'description'
  | 'visibility'
  | 'presentationKind'
  | 'coverMediaId';

export type CollectionMetadataHistoryBasis = {
  collectionRevision: number;
  curatorAccountId: string;
  viewerAccountId: string;
  authnEpoch: number;
  minimumAuthnEpoch: string;
};

export type CollectionMetadataHistoryCoverage = {
  coverage: 'complete' | 'partial' | 'unknown';
  knownFromRevision: number | null;
  prunedBeforeRevision: number | null;
};

export type CollectionMetadataHistoryPage = {
  collectionId: string;
  basis: CollectionMetadataHistoryBasis;
  coverage: CollectionMetadataHistoryCoverage;
  items: {
    revision: number;
    recordedAt: string;
    changedFields: CollectionMetadataHistoryField[];
  }[];
  next: string | null;
  actions: { review: true; reapply: false };
};

export type CollectionMetadataHistorySnapshot = {
  title: string;
  description: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  presentationKind: string | null;
  cover:
    | { state: 'none' }
    | { state: 'unavailable' }
    | { state: 'available'; mediaId: string };
};

export type CollectionMetadataHistoryChange = {
  collectionId: string;
  revision: number;
  recordedAt: string;
  changedFields: CollectionMetadataHistoryField[];
  before: CollectionMetadataHistorySnapshot;
  after: CollectionMetadataHistorySnapshot;
  basis: CollectionMetadataHistoryBasis;
  actions: { review: true; reapply: false };
};

export type CollectionMetadataHistoryRead<T> = { state: 'available'; value: T } | { state: 'unavailable' };

export type CollectionMetadataHistoryPageInput = {
  collectionId: string;
  cursor: string | null;
  limit: number;
};

export type CollectionMetadataHistoryChangeInput = { collectionId: string; revision: number };

/** Typed receiving seam; the published KernelClient history methods are not installed on this source yet. */
export type CollectionMetadataHistorySource = {
  readPage: (input: CollectionMetadataHistoryPageInput) => Promise<CollectionMetadataHistoryRead<CollectionMetadataHistoryPage>>;
  readChange: (input: CollectionMetadataHistoryChangeInput) => Promise<CollectionMetadataHistoryRead<CollectionMetadataHistoryChange>>;
};
