import type { Pool, PoolClient } from 'pg';
import type { DurableInitiatorReader, DurableOperationAnchor } from '../access/durable-initiator.ts';
import type { KernelClock } from '../clock.ts';
import { type CommandAuthorization, type CommandOutcome, type CommandTransaction } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import type { Access, Actor } from '../request/access.ts';
import type { BuiltinCollectionKey } from './builtin-identity.ts';
import type { Collection } from './collection-model.ts';
import { type SavedCollectionRule } from './collection-rules.ts';
import type { CollectionPublicationBeginInput, CollectionPublicationCreation, CollectionPublicationEpisode } from './collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
export { COLLECTION_PUBLICATION_COMMAND, COLLECTION_PUBLICATION_WORKFLOW } from './contract/index.ts';
type Client = Pick<PoolClient, 'query'>;
export type CollectionPublicationBeginResult = Readonly<{
    locator: CollectionPublicationLocator;
    durableInitiator: string;
    collection?: Collection;
}>;
/** Server-owned saved creation joins the ordinary Publication command, never a second transaction. */
export type SavedPublicationCreation = Readonly<{
    input: unknown;
    rule: SavedCollectionRule;
    authorization: CommandAuthorization;
    materialize(tx: CommandTransaction): Promise<Collection>;
}>;
export type CollectionPublicationEpisodes = Readonly<{
    begin(actor: Actor, input: CollectionPublicationBeginInput, requestKey: string, creation?: SavedPublicationCreation): Promise<CommandOutcome<CollectionPublicationBeginResult>>;
}>;
export type CollectionPublicationEpisodeReader = (client: Client, locator: CollectionPublicationLocator) => Promise<CollectionPublicationEpisode | null>;
export declare const canonicalPublicationData: (value: unknown) => string;
export declare const hashPublicationData: (value: unknown) => string;
export declare function exactPublicationObject(value: object, keys: readonly string[]): boolean;
type Loaded = {
    creation: CollectionPublicationCreation;
    phase: 'staging' | 'awaiting_activation' | 'refused' | 'complete';
    version: string;
};
/** The owning header mutation already holds its ordinary Collection write lock. Retire only the
 * single pending episode (the native partial unique index enforces that bound). Immutable creation,
 * output, staging and custody rows remain available to their existing retention/disposition owners.
 * Cancel the exact pending output so its unique building slot can admit the next explicit publish.
 * Refusal is final: neither a receipt replay nor a late phase CAS can make this episode pending again.
 */
export declare function retireCollectionPublicationWork(tx: CommandTransaction, route: number, collectionId: string): Promise<void>;
/** Exact immutable operation/source point, followed by its exact receipt PK. No history fallback. */
export declare function loadCollectionPublicationCreation(client: Client, operation: DurableOperationAnchor): Promise<Loaded | null>;
/** Original native reader. Common Accounts restoration independently repeats receipt/commitment and current identity checks. */
export declare const readCollectionPublicationInitiator: DurableInitiatorReader;
export declare function loadCollectionPublicationLocator(client: Client, locator: CollectionPublicationLocator): Promise<Loaded | null>;
/** Data only. Pending/refused B and selected complete A always have separate native references. */
export declare const readCollectionPublicationEpisode: CollectionPublicationEpisodeReader;
/** Current pinned meaning only, on the caller's SAME client. No re-admission at a later release/head. */
export declare function readCollectionPublicationRule(client: Client, locator: CollectionPublicationLocator): Promise<SavedCollectionRule | null>;
export type CollectionPublicationMeaning = Readonly<{
    rule: SavedCollectionRule;
    key: Exclude<BuiltinCollectionKey, {
        kind: 'liked';
    }> | null;
}>;
export declare function readCollectionPublicationMeaning(client: Client, route: number, collectionId: string): Promise<CollectionPublicationMeaning | null>;
export declare function createCollectionPublicationEpisodes(config: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
}): CollectionPublicationEpisodes;
/** Version is mutable scheduling data, never an admission or a completion receipt. */
export declare function readCollectionPublicationEpisodeVersion(client: Client, locator: CollectionPublicationLocator): Promise<string | null>;
/** Bounded mechanical phase CAS uses the actual live Core step and its owning admission port.
 * Final activation owns the complete transition; this helper cannot manufacture completion.
 */
export declare function advanceCollectionPublicationEpisodePhase(tx: OperationalTransaction, locator: CollectionPublicationLocator, expected: Readonly<{
    version: string;
    phase: 'staging' | 'awaiting_activation';
}>, phase: 'awaiting_activation' | 'refused'): Promise<boolean>;
/** Existing terminal participant only. Erase private operation/actor/rule refs even when selected A survives.
 * SDK/receiving/core history custody remains a separate pending obligation, never a NoData assertion.
 */
export declare function purgeCollectionPublicationEpisodes(tx: CommandTransaction, input: Readonly<{
    accountId: string;
    limit: number;
}>): Promise<Readonly<{
    removed: number;
    exhausted: boolean;
}>>;
