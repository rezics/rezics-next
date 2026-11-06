import { type ContentReadDependencies } from './reads.ts';
import type { ReadContext } from './model.ts';
import { type ReviewCensusCoverage, type ReviewCensusStep } from './review-census.ts';
export declare const REVIEW_DISCOVERY_READ_LIMIT = 100;
export declare const REVIEW_DISCOVERY_PAGE_LIMIT = 25;
export declare const REVIEW_DISCOVERY_CANDIDATE_FACTOR = 4;
export declare const REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES: number;
export declare const REVIEW_DISCOVERY_MAX_DEPENDENCIES = 512;
export declare const REVIEW_DISCOVERY_MAX_CUT_HOMES = 256;
/** Candidate fields only. Author presentation is read from Accounts during final hydration. */
export type IndexedReview = Readonly<{
    id: string;
    subjectId: string;
    title: string | null;
    excerpt?: string;
    revisionId: string;
    /** Opaque per-review currentness proof. It is not disclosure authority or a content identity. */
    sourceVersion: string;
}>;
/** Current Content-owned fields for a Search hit; the author ID is an Accounts lookup key, not display text. */
export type ReviewDiscoverySummary = Readonly<{
    id: string;
    subjectId: string;
    authorId: string;
    title: string | null;
    excerpt?: string;
    /** Opaque per-review currentness proof. It is not disclosure authority or a content identity. */
    sourceVersion: string;
}>;
export type ReviewDiscoverySnapshot = Readonly<{
    partition: number;
    /** Exact core.partition.position from the same repeatable-read snapshot as these rows. */
    position: bigint;
    reviews: readonly IndexedReview[];
}>;
export type ReviewDiscoveryHydration = Readonly<{
    partition: number;
    position: bigint;
    reviews: readonly (ReviewDiscoverySummary & {
        revisionId: string;
    })[];
}>;
export type ReviewDiscoveryPageKey = Readonly<{
    route: number;
    id: string;
}>;
export type ReviewDiscoveryPage = ReviewDiscoverySnapshot & Readonly<{
    next: ReviewDiscoveryPageKey | null;
}>;
export type ReviewDiscoveryIncompletePage = Readonly<{
    partition: number;
    position: bigint;
    incomplete: 'cut-required' | 'cut-changed';
}>;
export type ReviewDiscoveryHomeObservation = Readonly<{
    partition: number;
    epoch: number;
    position: string;
    /** Native projection equality, independent of domain publication positions. */
    projection?: string;
}>;
export type ReviewDiscoveryContinuation = ReviewDiscoveryPageKey & Readonly<{
    token: string;
}>;
export type ReviewDiscoveryPopulationPage = (ReviewDiscoverySnapshot & Readonly<{
    state: 'ready';
    next: ReviewDiscoveryContinuation | null;
}>) | Readonly<{
    state: 'preparing' | 'changed' | 'unavailable';
    partition: number;
    position: bigint | null;
    reviews: readonly [];
    next: null;
    missing: string;
}>;
export type ReviewDiscoveryCount = Readonly<{
    partition: number;
    position: bigint;
    unavailable: true;
}> | Readonly<{
    partition: number;
    position: bigint;
    total: number;
    coverage: 'complete';
    generation: string;
}>;
export type ReviewDiscoverySource = Readonly<{
    read(partition: number, ids: readonly string[]): Promise<ReviewDiscoverySnapshot>;
    hydrate(partition: number, ids: readonly string[]): Promise<ReviewDiscoveryHydration>;
    count(partition: number): Promise<ReviewDiscoveryCount>;
    page(partition: number, after: ReviewDiscoveryPageKey | null, limit: number, cut?: bigint): Promise<ReviewDiscoveryPage | ReviewDiscoveryIncompletePage>;
    /** Coherent native population pages; legacy `page` keys cannot carry this coverage proof. */
    pageWithCut?(partition: number, after: ReviewDiscoveryPageKey | ReviewDiscoveryContinuation | null, limit: number): Promise<ReviewDiscoveryPopulationPage>;
}>;
/** Additional native maintenance ports. Search's legacy Count remains compatible;
 * candidate installation does not grant it anonymous eligibility coverage. */
export type NativeReviewDiscoverySource = ReviewDiscoverySource & Readonly<{
    pageWithCut: NonNullable<ReviewDiscoverySource['pageWithCut']>;
    maintainCensus(partition: number): Promise<ReviewCensusStep>;
    censusCoverage(partition: number): Promise<ReviewCensusCoverage>;
}>;
export declare const REVIEW_DISCOVERY_BOUNDS: Readonly<{
    readIds: 100;
    pageLimit: 25;
    candidatesPerResult: 4;
    maxPageCandidates: number;
    currentOwnerReadsPerCandidate: 2;
    currentOwnerReadsPerOperation: number;
    dependencyRowsPerOperation: 512;
    continuationHomes: 256;
    countCandidateReads: 0;
}>;
export declare class ReviewDiscoverySourceError extends Error {
    readonly state: 'changed' | 'unavailable' | 'preparing';
    readonly missing: string;
    readonly code: 'review_discovery_unavailable';
    constructor(state: 'changed' | 'unavailable' | 'preparing', missing: string);
}
/** Public-only producer. Search owns the document union, writer, and query integration. */
export declare function createReviewDiscoverySource(dependencies: ContentReadDependencies, makeAnonymousContext: () => ReadContext): NativeReviewDiscoverySource;
