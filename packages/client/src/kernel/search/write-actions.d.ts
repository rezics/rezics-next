import { type IndexAction, type SearchDocument } from './document.ts';
import type { OpenSearch } from './opensearch.ts';
import type { DiscoveryIndexAction, DiscoveryRegistry } from './discovery.ts';
/** A bulk write did not establish its required index visibility guarantee. */
export declare class IndexWriteError extends Error {
    readonly items: unknown[];
    constructor(items: unknown[]);
}
/** Native mixed writer. A conflict settles only an identical, actually search-visible keyed winner. */
export declare function writeDiscoveryActions(search: OpenSearch, registry: DiscoveryRegistry, index: string, actions: readonly DiscoveryIndexAction[]): Promise<void>;
export declare function validateRefreshResponse(status: number, response: unknown): void;
/**
 * Write one batch to a physical index, preserving external versions and complete bodies.
 * Return only after every action is visible to search, including independently winning
 * writes behind accepted external-version conflicts.
 */
export declare function writeIndexActions<Document extends SearchDocument>(search: OpenSearch, index: string, actions: readonly IndexAction<Document>[], options?: {
    rejectConflicts?: boolean;
    writeAlias?: string;
}): Promise<void>;
