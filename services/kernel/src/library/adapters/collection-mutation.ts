/** Native metadata effects. Every leaf uses the caller's exact query client and retained declaration. */
import type { PoolClient } from 'pg';
import type { CollectionMutationPorts } from '../contract/index.ts';
import { runLibraryBoundedStep } from '../collection-command-work.ts';
import {
  collectionMetadataHistoryCapturePlan,
  collectionMetadataHistoryInitializePlan,
  executeCollectionMetadataHistoryInitialize,
  executeCollectionMetadataHistoryOwner,
  executeCollectionMetadataHistoryAppend,
  executeCollectionMetadataHistoryPrune,
  executeCollectionMetadataHistoryPruned,
} from '../collection-history-bounds.ts';

type Client = Pick<PoolClient, 'query'>;

export function createNativeCollectionMutationPorts(): CollectionMutationPorts<Client> {
  return {
    planCapture: collectionMetadataHistoryCapturePlan,
    async initialize(tx, input, plan = collectionMetadataHistoryInitializePlan(input)) {
      await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryInitialize(tx, plan));
    },
    async owner(tx, plan) {
      await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryOwner(tx, plan));
    },
    async append(tx, plan) {
      return (
        await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryAppend(tx, plan))
      ).length;
    },
    async prune(tx, plan) {
      return (await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryPrune(tx, plan)))
        .length;
    },
    async pruned(tx, plan) {
      await runLibraryBoundedStep(plan.kind, plan.total, () => executeCollectionMetadataHistoryPruned(tx, plan));
    },
  };
}
