import type { KnowledgeDiscoveryCandidate, KnowledgeDiscoverySource, KnowledgeDiscoverySummary } from '../content/index.ts';
import type { KeyRing } from '../tokens/seal.ts';
export declare const KNOWLEDGE_DISCOVERY_PAGE_LIMIT = 20;
export declare const KNOWLEDGE_DISCOVERY_STEP_LIMIT = 128;
export declare const KNOWLEDGE_DISCOVERY_LIFETIME_MS: number;
export type KnowledgeAssociation = KnowledgeDiscoveryCandidate & Readonly<{
    sequence: string;
}>;
export type KnowledgeFrontier = Readonly<{
    publishedAt: string;
    documentId: string;
    publicationId: string;
}>;
export type KnowledgePreparation = Readonly<{
    id: string;
    revision: number;
    subjectId: string;
    limit: number;
    through: string;
    after: KnowledgeFrontier | null;
    /** Retained identities are nominations, not retained Access decisions or public summaries. */
    candidates: readonly KnowledgeAssociation[];
    exhausted: boolean;
    expiresAt: number;
}>;
export type KnowledgeDiscoveryStore = Readonly<{
    /** Null means this index has not completed installation. Zero is a complete empty observation. */
    cut(subjectId: string): Promise<string | null>;
    page(subjectId: string, after: KnowledgeFrontier | null, limit: number): Promise<readonly KnowledgeAssociation[]>;
    load(id: string): Promise<KnowledgePreparation | null>;
    save(record: KnowledgePreparation, previousRevision: number | null): Promise<boolean>;
    id(): string;
}>;
export type KnowledgeDiscoveryRequest = Readonly<{
    limit?: number;
    cursor?: string;
}>;
export type KnowledgeDiscoveryPage = Readonly<{
    state: 'ready';
    documents: readonly KnowledgeDiscoverySummary[];
    next: string | null;
}> | Readonly<{
    state: 'preparing';
    next: string;
}> | Readonly<{
    state: 'unavailable';
}>;
/** Fixed indexed membership; current Content disclosure is deliberately refreshed on every step.
 * One caller-driven step retains progress. No worker, timer, home scan or full body read is needed. */
export declare function createKnowledgeDiscovery(options: {
    store: KnowledgeDiscoveryStore;
    source?: KnowledgeDiscoverySource;
    tokens: KeyRing;
    now: () => number;
}): (subjectId: string, principal: 'anonymous' | `account:${string}`, request: KnowledgeDiscoveryRequest, context: Readonly<{
    deadline: number;
}>) => Promise<KnowledgeDiscoveryPage>;
