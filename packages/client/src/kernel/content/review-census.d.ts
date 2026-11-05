import type { Pool, PoolClient } from 'pg';
import type { ReviewDiscoveryContinuation, ReviewDiscoveryHomeObservation } from './review-discovery.ts';
export declare const REVIEW_CENSUS_PAGE_SIZE = 25;
export declare const REVIEW_CENSUS_EPISODE_LIMIT = 100;
export type ReviewCensusCut = Readonly<{
    homes: readonly ReviewDiscoveryHomeObservation[];
    frontier: string;
}>;
/** Internal retained identity evidence. Never serialize this on a public page. */
export type ReviewCensusEpisode = Readonly<{
    route: number;
    id: string;
    boardId: string | null;
    realmId: string | null;
    subjectId: string | null;
    openingId: string | null;
    revisionId: string | null;
    sourceVersion: string;
    eligible: boolean;
}>;
export type ReviewCensusObservation = Readonly<{
    state: 'ready';
    position: bigint;
    cut: ReviewCensusCut;
}> | Readonly<{
    state: 'preparing' | 'changed' | 'unavailable';
    position: bigint | null;
    missing: string;
}>;
export type ReviewCensusPage = Readonly<{
    state: 'ready';
    position: bigint;
    cut: ReviewCensusCut;
    episodes: readonly ReviewCensusEpisode[];
    next: ReviewDiscoveryContinuation | null;
}> | Exclude<ReviewCensusObservation, {
    state: 'ready';
}>;
/** Candidate installation is intentionally weaker than anonymous eligibility coverage. */
export type ReviewCensusCoverage = Readonly<{
    state: 'ready';
    partition: number;
    position: bigint;
    generation: string;
    installed: true;
    total: number;
}> | Readonly<{
    state: 'preparing' | 'unavailable';
    partition: number;
    position: bigint | null;
    generation: string | null;
    installed: boolean;
    missing: string;
}>;
export type ReviewCensusStep = Readonly<{
    state: 'progress' | 'exhausted' | 'changed' | 'preparing' | 'unavailable';
    generation: string;
    examined: number;
}>;
type Reader = Readonly<{
    page(partition: number, after: ReviewDiscoveryContinuation | null, deadline: number): Promise<ReviewCensusPage>;
    observe(client: Pick<PoolClient, 'query'>, partition: number, cut: ReviewCensusCut | null, episodes?: readonly ReviewCensusEpisode[]): Promise<ReviewCensusObservation>;
}>;
export declare function sameReviewCensusCut(left: ReviewCensusCut, right: ReviewCensusCut): boolean;
/** Durable native projection maintenance. Like the existing Realm Subject candidate
 * store, projection writes do not invent a domain log position. Owner observations
 * happen before writes, and only core home metadata is rechecked during the CAS.
 * Readiness still depends on the reader's current anonymous authority observations.
 */
export declare function createReviewCensus(pool: Pool, reader: Reader): Readonly<{
    coverage(partition: number, deadline: number): Promise<ReviewCensusCoverage>;
    step(partition: number, deadline: number): Promise<ReviewCensusStep>;
}>;
export {};
