import { collectionMutationApplication } from './collection-mutation.ts';
import type { PoolClient } from 'pg';
import type { Collection, CollectionDraft, CollectionVisibility } from './collection-model.ts';
import { runLibraryBoundedStep } from './collection-command-work.ts';
import {
  COLLECTION_METADATA_HISTORY_LIMIT,
  COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE,
  COLLECTION_METADATA_HISTORY_PAGE_SIZE,
  collectionMetadataHistoryCapturePlan,
  collectionMetadataHistoryEntryPlan,
  collectionMetadataHistoryInitializePlan,
  collectionMetadataHistoryPagePlan,
  collectionMetadataHistoryStatePlan,
  executeCollectionMetadataHistoryEntry,
  executeCollectionMetadataHistoryPage,
  executeCollectionMetadataHistoryState,
} from './collection-history-bounds.ts';

type Client = Pick<PoolClient, 'query'>;
export {
  COLLECTION_METADATA_HISTORY_LIMIT,
  COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE,
  COLLECTION_METADATA_HISTORY_PAGE_SIZE,
};

export { COLLECTION_METADATA_FIELDS } from './contract/index.ts';
export type {
  CollectionMetadataField,
  CollectionMetadataHistoryCoverage,
  CollectionMetadataSnapshot,
  CollectionMetadataHistoryEntry,
  CollectionMetadataHistoryBasis,
  CollectionMetadataHistoryPageItem,
  CollectionMetadataHistoryPage,
  CollectionMetadataHistoryCover,
  CollectionMetadataHistorySnapshot,
  CollectionMetadataHistoryDetail,
  CollectionMetadataHistoryState,
} from './contract/index.ts';
import {
  COLLECTION_METADATA_FIELDS,
  type CollectionMetadataField,
  type CollectionMetadataHistoryEntry,
  type CollectionMetadataHistoryState,
} from './contract/index.ts';

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
  return collectionMutationApplication().initializeHistory(client, input, plan);
}

/** Capture one committed metadata transition; replay and no-op metadata commands add no row. */
export async function captureCollectionMetadataHistory(
  client: Client,
  input: { route: number; before: Collection; after: Collection; transactionId: string; time: string },
  plan = collectionMetadataHistoryCapturePlan(input),
): Promise<void> {
  return collectionMutationApplication().captureHistory(client, input, plan);
}

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
