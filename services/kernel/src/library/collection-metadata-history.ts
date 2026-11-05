import type { PoolClient } from 'pg';
import type { Collection, CollectionDraft, CollectionVisibility } from './collection-model.ts';
import type { CoverSummary } from '../semantic/summaries.ts';
import { runLibraryBoundedStep } from './command-support.ts';
import {
  COLLECTION_METADATA_HISTORY_LIMIT,
  COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE,
  COLLECTION_METADATA_HISTORY_PAGE_SIZE,
  collectionMetadataHistoryCapturePlan,
  collectionMetadataHistoryEntryPlan,
  collectionMetadataHistoryInitializePlan,
  collectionMetadataHistoryPagePlan,
  collectionMetadataHistoryStatePlan,
  executeCollectionMetadataHistoryAppend,
  executeCollectionMetadataHistoryEntry,
  executeCollectionMetadataHistoryInitialize,
  executeCollectionMetadataHistoryOwner,
  executeCollectionMetadataHistoryPage,
  executeCollectionMetadataHistoryPrune,
  executeCollectionMetadataHistoryPruned,
  executeCollectionMetadataHistoryState,
} from './collection-history-bounds.ts';

type Client = Pick<PoolClient, 'query'>;
export {
  COLLECTION_METADATA_HISTORY_LIMIT,
  COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE,
  COLLECTION_METADATA_HISTORY_PAGE_SIZE,
};

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

export async function initializeCollectionMetadataHistory(
  client: Client,
  input: {
    route: number;
    collection: Pick<CollectionDraft, 'id' | 'curatorAccountId'>;
    transactionId: string;
    time: string;
  },
  plan = collectionMetadataHistoryInitializePlan(input),
): Promise<void> {
  await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryInitialize(client, plan));
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
  plan = collectionMetadataHistoryCapturePlan(input),
): Promise<void> {
  const curatorAccountId = input.after.curatorAccountId;
  if (curatorAccountId === null) throw new Error('A metadata write needs a current Collection curator');
  if (plan.changedFields.length === 0) return;
  const { owner: ownerPlan, append: appendPlan, prune: prunePlan, pruned: prunedPlan } = plan.leaves;
  if (!ownerPlan || !appendPlan || !prunePlan || !prunedPlan) throw new Error('Metadata transition plan is incomplete');
  await runLibraryBoundedStep(ownerPlan.kind, ownerPlan.total, () =>
    executeCollectionMetadataHistoryOwner(client, ownerPlan),
  );
  const rows = await runLibraryBoundedStep(appendPlan.kind, appendPlan.total, () =>
    executeCollectionMetadataHistoryAppend(client, appendPlan),
  );
  if (rows.length !== 1) throw new Error('Collection metadata history did not record one native change');
  const removed = await runLibraryBoundedStep(prunePlan.kind, prunePlan.total, () =>
    executeCollectionMetadataHistoryPrune(client, prunePlan),
  );
  if (removed.length > 1) throw new Error('Collection metadata history exceeded its one-row prune bound');
  if (removed.length === 1)
    await runLibraryBoundedStep(prunedPlan.kind, prunedPlan.total, () =>
      executeCollectionMetadataHistoryPruned(client, prunedPlan),
    );
}

export type CollectionMetadataHistoryState = {
  coverage: CollectionMetadataHistoryCoverage;
  knownFromRevision: number | null;
  prunedBeforeRevision: number | null;
};

export async function readCollectionMetadataHistoryState(
  client: Client,
  input: { route: number; collectionId: string; curatorAccountId: string },
  plan = collectionMetadataHistoryStatePlan(input),
): Promise<CollectionMetadataHistoryState> {
  const row = await runLibraryBoundedStep(plan.kind, plan.total, () =>
    executeCollectionMetadataHistoryState(client, plan),
  );
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
  plan = collectionMetadataHistoryPagePlan({
    route: input.route,
    collectionId: input.collectionId,
    curatorAccountId: input.curatorAccountId,
    afterRevision: input.afterRevision,
    limit: input.limit,
  }),
) {
  return runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryPage(client, plan));
}

export function collectionMetadataHistoryFields(value: readonly (string | null)[]): CollectionMetadataField[] {
  const fields = new Set(value);
  if (
    [...fields].some(
      (field) => typeof field !== 'string' || !(COLLECTION_METADATA_FIELDS as readonly string[]).includes(field),
    )
  )
    throw new Error('Invalid Collection metadata history field');
  return COLLECTION_METADATA_FIELDS.filter((field) => fields.has(field));
}

export async function readCollectionMetadataHistoryEntry(
  client: Client,
  input: { route: number; collectionId: string; curatorAccountId: string; revision: number },
  plan = collectionMetadataHistoryEntryPlan(input),
) {
  return await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryEntry(client, plan));
}

export function collectionMetadataHistoryEntry(row: {
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
