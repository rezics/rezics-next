import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
/** Immutable nine-axis declarations for the existing Collection metadata journal SQL. */
import type { PoolClient } from 'pg';
type QueryClient = Pick<PoolClient, 'query'>;
import append from './collection-metadata-history-append.sql';
import init from './collection-metadata-history-init.sql';
import owner from './collection-metadata-history-owner.sql';
import page from './collection-metadata-history-page.sql';
import prune from './collection-metadata-history-prune.sql';
import pruned from './collection-metadata-history-pruned.sql';
import read from './collection-metadata-history-read.sql';
import state from './collection-metadata-history-state.sql';
import { COLLECTION_PUBLICATION_STEP_CEILING } from './collection-publication-bounds.ts';

import { createCollectionHistoryPlans } from './core/index.ts';
import type { CollectionMetadataHistorySqlPlan } from './contract/index.ts';
export {
  COLLECTION_METADATA_HISTORY_LIMIT,
  COLLECTION_METADATA_HISTORY_PAGE_SIZE,
  COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE,
} from './core/index.ts';
export type { CollectionMetadataSnapshotInput, CollectionMetadataFieldInput } from './core/index.ts';
export type { CollectionMetadataHistorySqlPlan, CollectionMetadataHistoryCapturePlan } from './contract/index.ts';

function plans() {
  return memoizedValue(plans, () =>
    createCollectionHistoryPlans(
      {
        append: { bytes: statementBytes(append) },
        init: { bytes: statementBytes(init) },
        owner: { bytes: statementBytes(owner) },
        page: { bytes: statementBytes(page) },
        prune: { bytes: statementBytes(prune) },
        pruned: { bytes: statementBytes(pruned) },
        read: { bytes: statementBytes(read) },
        state: { bytes: statementBytes(state) },
      },
      COLLECTION_PUBLICATION_STEP_CEILING(),
    ),
  );
}

export function collectionMetadataHistoryInitializePlan(
  input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryInitializePlan']>[0],
) {
  return plans().collectionMetadataHistoryInitializePlan(input);
}

export function collectionMetadataHistoryCapturePlan(
  input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryCapturePlan']>[0],
) {
  return plans().collectionMetadataHistoryCapturePlan(input);
}

export function collectionMetadataHistoryStatePlan(
  input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryStatePlan']>[0],
) {
  return plans().collectionMetadataHistoryStatePlan(input);
}

export function collectionMetadataHistoryPagePlan(
  input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryPagePlan']>[0],
) {
  return plans().collectionMetadataHistoryPagePlan(input);
}

export function collectionMetadataHistoryEntryPlan(
  input: Parameters<ReturnType<typeof createCollectionHistoryPlans>['collectionMetadataHistoryEntryPlan']>[0],
) {
  return plans().collectionMetadataHistoryEntryPlan(input);
}

export function executeCollectionMetadataHistoryInitialize(
  client: QueryClient,
  plan: CollectionMetadataHistorySqlPlan,
) {
  return init.run(client, plan.input as Parameters<typeof init.run>[1]);
}
export function executeCollectionMetadataHistoryOwner(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return owner.run(client, plan.input as Parameters<typeof owner.run>[1]);
}
export function executeCollectionMetadataHistoryAppend(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return append.run(client, plan.input as Parameters<typeof append.run>[1]);
}
export function executeCollectionMetadataHistoryPrune(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return prune.run(client, plan.input as Parameters<typeof prune.run>[1]);
}
export function executeCollectionMetadataHistoryPruned(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return pruned.run(client, plan.input as Parameters<typeof pruned.run>[1]);
}
export function executeCollectionMetadataHistoryState(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return state.run(client, plan.input as Parameters<typeof state.run>[1]);
}
export function executeCollectionMetadataHistoryPage(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return page.run(client, plan.input as Parameters<typeof page.run>[1]);
}
export function executeCollectionMetadataHistoryEntry(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return read.run(client, plan.input as Parameters<typeof read.run>[1]);
}
