import { type CommandTransaction } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type OpenSearch } from '../search/opensearch.ts';
import { createSearchScopeSource } from '../search/scope-source.ts';
import { type CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { CollectionOutputRef } from './collection-source-output.ts';
import type { WorkAllowance, WorkReceipt } from './contract/work-dimensions.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import { type CollectionPublicationFrontier } from './collection-publication-staging-state.ts';
type Runtime = Parameters<typeof createSearchScopeSource>[0];
/** Search client used to revalidate public catalogue generation/uuid/index at seal and readback. */
export type CollectionPublicationSearch = Readonly<{
    client: OpenSearch;
    prefix: string;
    deadline: number;
}>;
/** The actual Search service configuration, including its server-only work role. No driver/policy callbacks. */
export type CollectionPublicationStagingOptions = Runtime & Readonly<{
    allowance: WorkAllowance;
}>;
export type CollectionPublicationStagingCheckpoint = Readonly<{
    output: CollectionOutputRef;
    version: string;
    frontier: CollectionPublicationFrontier;
}>;
/** Native receipt data only, freshly reread on use; never accepted as an activation input. */
export type CollectionPublicationStagingSeal = Readonly<{
    output: CollectionOutputRef;
    publicationId: string;
    definitionDigest: string;
    members: string;
    version: string;
    nativeXid: string;
    position: string;
}>;
export type CollectionPublicationStagingResult = Readonly<{
    state: 'more' | 'sealed';
    checkpoint: CollectionPublicationStagingCheckpoint;
    work: WorkReceipt;
}>;
export declare function readCollectionPublicationStagingCheckpoint(tx: OperationalTransaction, locator: CollectionPublicationLocator, work: NativeCollectionWork): Promise<CollectionPublicationStagingCheckpoint | null>;
/** A single canonical subject (including excluded subjects), or one sparse Source frontier, per bounded step.
 * There is no selected-set fallback, caller list, force/complete flag, second allowance or public Search write.
 * The registered owner worker can repeat this function with its native locator after each committed step.
 */
export declare function stageCollectionPublicationStep(tx: OperationalTransaction, locator: CollectionPublicationLocator, options: CollectionPublicationStagingOptions): Promise<CollectionPublicationStagingResult>;
/** Fresh native seal reader for final activation. It accepts a locator, never copied JSON or a permission callback.
 * Final bodies still own their ordinary current initiator/episode authorization and native complete-output hooks.
 */
export declare function readCollectionPublicationStagingSeal(tx: CommandTransaction, locator: CollectionPublicationLocator, work: NativeCollectionWork, search?: CollectionPublicationSearch): Promise<CollectionPublicationStagingSeal | null>;
export {};
