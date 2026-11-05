/** Explicit membership Publication storage. It never evaluates personal predicates or grants read authority. */
import type { PoolClient } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { CollectionPublicationEpisode } from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
/** Native receipt locator/provenance only. It carries no viewer or subject permission. */
export type CollectionOutputPublication = Readonly<{
    generation: string;
    transactionId: string;
    position: string;
    nativeXid: string;
    sourceGeneration: string;
    memberFence: string;
    members: string;
}>;
export type CollectionOutputRef = Readonly<{
    route: number;
    collectionId: string;
    generation: string;
}>;
type Client = Pick<PoolClient, 'query'>;
type StagingActivation = Readonly<{
    locator: CollectionPublicationLocator;
    work: NativeCollectionWork;
    version: string;
    phase: Extract<CollectionPublicationEpisode['phase'], 'staging' | 'awaiting_activation'>;
    selected: CollectionPublicationEpisode['selected'];
}>;
export declare function beginCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef & {
    readonly expectedMembers: number;
}): Promise<void>;
/** The episode's ordinary admitted begin command allocates UNKNOWN cardinality in the same native namespace.
 * This shares the original allocator/capacity rules. It neither selects B nor creates another generation ID.
 */
export declare function beginWholeQueryCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef): Promise<void>;
/** Strict sorted chunks are the explicit selection, not a partial query result. Source admission is caller-owned.
 * Checkpoint and rows share the native transaction. Replayed Core receipts skip this hook entirely.
 */
export declare function appendCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef & {
    readonly after: string | null;
    readonly subjectIds: readonly string[];
}): Promise<void>;
/** Atomic COMPLETE activation. A pending B never replaces completed A, including an explicitly empty A. */
export declare function completeCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef, staging?: StagingActivation): Promise<void>;
export declare function cancelCollectionSourceOutput(tx: CommandTransaction, input: CollectionOutputRef): Promise<void>;
/** Source-local exact inventory only. It proves neither destination disposition nor global account erasure. */
export declare function readCollectionSourceOutputInventory(client: Client, input: Readonly<{
    route: number;
    collectionId: string;
}>): Promise<{
    generation: string;
    state: 'building' | 'complete' | 'cancelled';
    members: string;
    publicationTransactionId: string | null;
    nativeXid: string | null;
}[]>;
export {};
