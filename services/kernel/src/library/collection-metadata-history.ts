import type { PoolClient } from 'pg';
import type { Collection, CollectionVisibility } from './collection-model.ts';
import type { CoverSummary } from '../semantic/summaries.ts';
import append from './collection-metadata-history-append.sql';
import init from './collection-metadata-history-init.sql';
import owner from './collection-metadata-history-owner.sql';
import page from './collection-metadata-history-page.sql';
import prune from './collection-metadata-history-prune.sql';
import pruned from './collection-metadata-history-pruned.sql';
import read from './collection-metadata-history-read.sql';
import state from './collection-metadata-history-state.sql';

type Client = Pick<PoolClient, 'query'>;
export const COLLECTION_METADATA_HISTORY_LIMIT = 128;
export const COLLECTION_METADATA_HISTORY_PAGE_SIZE = 25;
export const COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE = 50;

export const COLLECTION_METADATA_FIELDS = [
  'title',
  'description',
  'visibility',
  'presentationKind',
  'coverMediaId',
] as const;

export type CollectionMetadataField = (typeof COLLECTION_METADATA_FIELDS)[number];
export type CollectionMetadataHistoryCoverage = 'complete' | 'partial' | 'unknown';
export type CollectionMetadataSnapshot = Pick<
  Collection,
  'title' | 'description' | 'visibility' | 'presentationKind' | 'coverMediaId'
>;
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
export type CollectionMetadataHistoryPageItem = Pick<
  CollectionMetadataHistoryEntry,
  'revision' | 'recordedAt' | 'changedFields'
>;
export type CollectionMetadataHistoryPage = {
  collectionId: string;
  basis: CollectionMetadataHistoryBasis;
  coverage: CollectionMetadataHistoryState;
  items: CollectionMetadataHistoryPageItem[];
  next: string | null;
  actions: { review: true; reapply: false };
};
export type CollectionMetadataHistoryCover =
  | { state: 'none' }
  | { state: 'unavailable' }
  | { state: 'available'; mediaId: string; summary: CoverSummary };
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
  actions: { review: true; reapply: false };
};

function snapshot(collection: Collection): CollectionMetadataSnapshot {
  return {
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility,
    presentationKind: collection.presentationKind,
    coverMediaId: collection.coverMediaId,
  };
}

export async function initializeCollectionMetadataHistory(
  client: Client,
  input: {
    route: number;
    collection: Pick<Collection, 'id' | 'curatorAccountId'>;
    transactionId: string;
    time: string;
  },
): Promise<void> {
  await init.run(client, {
    route: input.route,
    collection_id: input.collection.id,
    curator_account_id: input.collection.curatorAccountId,
    transaction_id: input.transactionId,
    updated_at: input.time,
  });
}

/** Capture one committed metadata transition; replay and no-op metadata commands add no row. */
export async function captureCollectionMetadataHistory(
  client: Client,
  input: {
    route: number;
    before: Collection;
    after: Collection;
    transactionId: string;
    time: string;
  },
): Promise<void> {
  const before = snapshot(input.before);
  const after = snapshot(input.after);
  const changedFields = COLLECTION_METADATA_FIELDS.filter((field) => !Object.is(before[field], after[field]));
  if (changedFields.length === 0) return;

  const curatorAccountId = input.after.curatorAccountId;
  if (curatorAccountId === null) throw new Error('A metadata write needs a current Collection curator');
  await owner.run(client, {
    route: input.route,
    collection_id: input.after.id,
    curator_account_id: curatorAccountId,
    revision: input.after.revision,
    transaction_id: input.transactionId,
    updated_at: input.time,
  });
  const rows = await append.run(client, {
    route: input.route,
    collection_id: input.after.id,
    curator_account_id: curatorAccountId,
    revision: input.after.revision,
    transaction_id: input.transactionId,
    recorded_at: input.time,
    changed_fields: changedFields,
    before_title: before.title,
    after_title: after.title,
    before_description: before.description,
    after_description: after.description,
    before_visibility: before.visibility,
    after_visibility: after.visibility,
    before_presentation_kind: before.presentationKind,
    after_presentation_kind: after.presentationKind,
    before_cover_media_id: before.coverMediaId,
    after_cover_media_id: after.coverMediaId,
  });
  if (rows.length !== 1) throw new Error('Collection metadata history did not record one native change');
  const removed = await prune.run(client, { route: input.route, collection_id: input.after.id });
  if (removed.length > 1) throw new Error('Collection metadata history exceeded its one-row prune bound');
  if (removed.length === 1)
    await pruned.run(client, {
      route: input.route,
      collection_id: input.after.id,
      curator_account_id: curatorAccountId,
      transaction_id: input.transactionId,
      updated_at: input.time,
    });
}

export type CollectionMetadataHistoryState = {
  coverage: CollectionMetadataHistoryCoverage;
  knownFromRevision: number | null;
  prunedBeforeRevision: number | null;
};

export async function readCollectionMetadataHistoryState(
  client: Client,
  input: { route: number; collectionId: string; curatorAccountId: string },
): Promise<CollectionMetadataHistoryState> {
  const [row] = await state.run(client, {
    route: input.route,
    collection_id: input.collectionId,
    curator_account_id: input.curatorAccountId,
  });
  if (!row) return { coverage: 'unknown', knownFromRevision: null, prunedBeforeRevision: null };
  if (row.coverage !== 'complete' && row.coverage !== 'partial' && row.coverage !== 'unknown')
    throw new Error('Invalid Collection metadata history coverage');
  return {
    coverage: row.coverage,
    knownFromRevision: row.knownFromRevision,
    prunedBeforeRevision: row.prunedBeforeRevision,
  };
}

export async function pageCollectionMetadataHistory(
  client: Client,
  input: {
    route: number;
    collectionId: string;
    curatorAccountId: string;
    afterRevision: number | null;
    limit: number;
  },
) {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE + 1
  )
    throw new RangeError('Invalid Collection metadata history page size');
  return page.run(client, {
    route: input.route,
    collection_id: input.collectionId,
    curator_account_id: input.curatorAccountId,
    after_revision: input.afterRevision,
    page_limit: input.limit,
  });
}

export function collectionMetadataHistoryFields(value: readonly string[]): CollectionMetadataField[] {
  const fields = new Set(value);
  if ([...fields].some((field) => !(COLLECTION_METADATA_FIELDS as readonly string[]).includes(field)))
    throw new Error('Invalid Collection metadata history field');
  return COLLECTION_METADATA_FIELDS.filter((field) => fields.has(field));
}

export async function readCollectionMetadataHistoryEntry(
  client: Client,
  input: { route: number; collectionId: string; curatorAccountId: string; revision: number },
) {
  return (
    (
      await read.run(client, {
        route: input.route,
        collection_id: input.collectionId,
        curator_account_id: input.curatorAccountId,
        revision: input.revision,
      })
    )[0] ?? null
  );
}

export function collectionMetadataHistoryEntry(row: {
  revision: number;
  transactionId: string;
  recordedAt: string;
  changedFields: string[];
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
}): CollectionMetadataHistoryEntry {
  const changedFields = collectionMetadataHistoryFields(row.changedFields);
  const visibility = (value: string): CollectionVisibility => {
    if (value !== 'private' && value !== 'unlisted' && value !== 'public')
      throw new Error('Invalid historical Collection visibility');
    return value;
  };
  return {
    revision: row.revision,
    transactionId: row.transactionId,
    recordedAt: new Date(row.recordedAt).toISOString(),
    changedFields,
    before: {
      title: row.beforeTitle,
      description: row.beforeDescription,
      visibility: visibility(row.beforeVisibility),
      presentationKind: row.beforePresentationKind,
      coverMediaId: row.beforeCoverMediaId,
    },
    after: {
      title: row.afterTitle,
      description: row.afterDescription,
      visibility: visibility(row.afterVisibility),
      presentationKind: row.afterPresentationKind,
      coverMediaId: row.afterCoverMediaId,
    },
  };
}
