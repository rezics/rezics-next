import type {
  DiscoveryIndexAction, DiscoveryKey, DiscoveryRegistry, DiscoverySnapshot, IndexedDiscoveryDocument,
} from './discovery.ts';
export declare function discoveryDocumentId(registry: DiscoveryRegistry, key: DiscoveryKey): string;
export declare function parseDiscoveryDocumentId(registry: DiscoveryRegistry, id: string): DiscoveryKey;
export declare function discoveryDocumentActions(
  registry: DiscoveryRegistry,
  observation: DiscoverySnapshot,
  keys: readonly DiscoveryKey[],
  counts?: ReadonlyMap<string, number>,
): DiscoveryIndexAction[];
export declare function validateDiscoveryDocument(registry: DiscoveryRegistry, value: unknown): IndexedDiscoveryDocument;
export declare function parseDiscoveryHitIdentity(registry: DiscoveryRegistry, hit: unknown): DiscoveryKey;
export declare function discoveryBulkBody(registry: DiscoveryRegistry, index: string, actions: readonly DiscoveryIndexAction[]): string;
export declare function discoveryIndexDefinition(): {
  settings: object;
  mappings: { _meta: { discovery_document_format: number; name_sort_format: number; document_identity: string }; dynamic: string; properties: object };
};
