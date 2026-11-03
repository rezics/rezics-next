import { MIXED_DISCOVERY_DOCUMENT_FORMAT, type DiscoveryIndexAction, type DiscoveryIndexDefinition, type DiscoveryKey, type DiscoveryUnionKey, type DiscoveryRegistry, type DiscoverySnapshot, type IndexedDiscoveryDocument } from './discovery.ts';
export type MixedDiscoveryDocumentCodec = 'mixed-public-v1' | 'mixed-calendar-v1';
/** Bind each physical mixed mapping to exactly one writer codec. */
export declare function mixedDiscoveryDocumentCodec(mappings: unknown): MixedDiscoveryDocumentCodec | undefined;
/** Local codec seam until the closed DiscoveryKey/snapshot union owns these kinds. */
export type SecondScopeDiscoveryKey = {
    owner: 'commerce';
    kind: 'collection';
    route: number;
    id: string;
} | {
    owner: 'content';
    kind: 'review' | 'space';
    route: number;
    id: string;
};
export type DiscoveryDocumentKey = DiscoveryKey | SecondScopeDiscoveryKey;
export type SecondScopeDiscoveryRecord = {
    key: SecondScopeDiscoveryKey;
    revision: bigint;
    sourceVersion: string | null;
    names: readonly string[];
    descriptions: readonly string[];
    nameSort: string | null;
};
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
    document_format: typeof MIXED_DISCOVERY_DOCUMENT_FORMAT;
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
export declare function discoveryDocumentActions(registry: DiscoveryRegistry, observation: DiscoverySnapshot, keys: readonly DiscoveryKey[], counts?: ReadonlyMap<string, number>, format?: 'legacy' | 'mixed-public-v1' | 'mixed-calendar-v1'): DiscoveryIndexAction[];
/** Typed validator for the closed format-1/format-2 family and the local second-scope seam. */
export declare function validateDiscoveryDocumentFormat(registry: DiscoveryRegistry, value: unknown): DiscoveryDocumentValue;
/** Backward-compatible Subject/Account typing; validation still recognizes the strict second-scope seam. */
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
/** A fresh, inert definition for one shared native family; no index creation/alias switch is performed. */
export declare function discoveryIndexDefinition(): DiscoveryIndexDefinition;
/** Versioned successor; never modifies the immutable format-1 mapping. */
export declare function mixedDiscoveryIndexDefinition(): DiscoveryIndexDefinition;
/** Inert format-3 mapping: old mixed generations retain their year-only writer and mapping. */
export declare function mixedCalendarDiscoveryIndexDefinition(): DiscoveryIndexDefinition;
