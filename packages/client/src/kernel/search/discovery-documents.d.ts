import { DISCOVERY_DOCUMENT_FORMAT, type DiscoveryIndexAction, type DiscoveryIndexDefinition, type DiscoveryKey, type DiscoveryUnionKey, type DiscoveryRegistry, type DiscoverySnapshot, type IndexedDiscoveryDocument } from './discovery.ts';
import type { DiscoveryMetadataRecord, DiscoveryOwnerKey } from './discovery-api.ts';
/** A complete canonical physical mapping is required before any owner is projected or queried. */
export declare function hasDiscoveryDocumentFormat(mappings: unknown): boolean;
/** Distinct owner kinds share the canonical document format and identity. */
export type SecondScopeDiscoveryKey = DiscoveryOwnerKey;
export type DiscoveryDocumentKey = DiscoveryKey | SecondScopeDiscoveryKey;
export type SecondScopeDiscoveryRecord = DiscoveryMetadataRecord;
export type SecondScopeDiscoveryObservation = {
    owner: 'commerce' | 'content';
    snapshot: {
        partition: number;
        position: bigint;
        /** False or omitted means the native read cannot establish deletions for this keyset. */
        complete: boolean;
        records: readonly SecondScopeDiscoveryRecord[];
    };
};
export type SecondScopeIndexedDiscoveryDocument = {
    document_format: typeof DISCOVERY_DOCUMENT_FORMAT;
    identity: string;
    owner: 'commerce' | 'content';
    kind: 'collection' | 'review' | 'space';
    id: string;
    route: number;
    partition: number;
    source_position: string;
    revision: string;
    source_version: string | null;
    names: string[];
    descriptions: string[];
    name_sort: string | null;
};
export type SecondScopeDiscoveryIndexAction = {
    op: 'index';
    id: string;
    version: bigint;
    document: SecondScopeIndexedDiscoveryDocument;
} | {
    op: 'delete';
    id: string;
    version: bigint;
};
export type DiscoveryDocumentValue = IndexedDiscoveryDocument | SecondScopeIndexedDiscoveryDocument;
export type AnyDiscoveryIndexAction = DiscoveryIndexAction | SecondScopeDiscoveryIndexAction;
/** Canonical kind+ID key. Owner is resolved through the closed registry, never inferred from a raw UUID. */
export declare function discoveryDocumentId(registry: DiscoveryRegistry, key: DiscoveryDocumentKey): string;
/** A legacy UUID receipt is intentionally invalid here. Never pass tagged IDs to the legacy Subject parser. */
export declare function parseDiscoveryDocumentId(registry: DiscoveryRegistry, id: string): DiscoveryKey;
/** Typed decoder for every registered and second-scope native key. */
export declare function parseDiscoveryDocumentKey(registry: DiscoveryRegistry, id: string): DiscoveryDocumentKey;
/** One strict writer for Collection, review and Space records supplied by their owner adapters. */
export declare function secondScopeDiscoveryDocumentActions(registry: DiscoveryRegistry, observation: SecondScopeDiscoveryObservation, keys: readonly SecondScopeDiscoveryKey[]): SecondScopeDiscoveryIndexAction[];
/** Pure allowlist projection from an already authorized native observation; performs no owner/profile reads. */
export declare function discoveryDocumentActions(registry: DiscoveryRegistry, observation: DiscoverySnapshot, keys: readonly DiscoveryKey[], counts?: ReadonlyMap<string, number>): DiscoveryIndexAction[];
/** Typed validator for the canonical family and its distinct owner variants. */
export declare function validateDiscoveryDocumentFormat(registry: DiscoveryRegistry, value: unknown): DiscoveryDocumentValue;
/** Subject/Account typed view of the same strict canonical validator. */
export declare function validateDiscoveryDocument(registry: DiscoveryRegistry, value: unknown): IndexedDiscoveryDocument;
/** Typed parser for native mixed hits, including the local second-scope seam. */
export declare function parseDiscoveryHitKey(registry: DiscoveryRegistry, hit: unknown): DiscoveryDocumentKey;
/** Additive parser for native mixed hits. This never changes the UUID-only Subject receipt/parser contract. */
export declare function parseDiscoveryHitIdentity(registry: DiscoveryRegistry, hit: unknown): DiscoveryUnionKey;
/**
 * Raw native NDJSON, with exact signed-bigint external versions. The legacy bulkLines/OpenSearch.bulk path
 * serializes JS numbers and is deliberately not used for this format. No transport or generation is activated.
 */
export declare function discoveryBulkBody(registry: DiscoveryRegistry, index: string, actions: readonly AnyDiscoveryIndexAction[], options?: {
    writeAlias?: string;
    replayDeletes?: boolean;
}): string;
/** One complete inert definition; allocation and publication remain native lifecycle operations. */
export declare function discoveryIndexDefinition(): DiscoveryIndexDefinition;
