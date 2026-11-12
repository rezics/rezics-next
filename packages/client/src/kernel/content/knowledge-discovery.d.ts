import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
/** Native immutable selection identity. None of these fields grants read authority. */
export type KnowledgeDiscoveryCandidate = Readonly<{
    subjectId: string;
    documentId: string;
    publicationId: string;
    revisionId: string;
    publishedAt: string;
}>;
/** Navigation for the exact admitted selection; no private container, author, body or reference list. */
export type KnowledgeDiscoverySummary = KnowledgeDiscoveryCandidate & Readonly<{
    title: string;
    language: string | null;
    licence: string;
    sha256: string;
}>;
export type KnowledgeDiscoveryContext = Readonly<{
    deadline: number;
}>;
export type KnowledgeDiscoveryCurrent = Readonly<{
    status: 'ready';
    value: KnowledgeDiscoverySummary | null;
}> | Readonly<{
    status: 'unavailable';
}>;
export type KnowledgeDiscoverySource = Readonly<{
    /** The requested original Subject is checked as anonymous, even for a signed-in owner. */
    subject(subjectId: string, context: KnowledgeDiscoveryContext): Promise<'available' | 'withheld' | 'unavailable'>;
    /** Event receiving reads only the exact current selection's index keys. */
    selected(documentId: string, publicationId: string, context: KnowledgeDiscoveryContext): Promise<KnowledgeDiscoveryCandidate | null>;
    current(candidate: KnowledgeDiscoveryCandidate, context: KnowledgeDiscoveryContext): Promise<KnowledgeDiscoveryCurrent>;
}>;
/** The direct public reader and this seam use the same native current pointer and anonymous Subject checks.
 * This does not copy Content bytes or establish another publication authority. */
export declare function createKnowledgeDiscoverySource(deps: Readonly<{
    pool: Pool;
    access: Access;
}>): KnowledgeDiscoverySource;
