import type { Pool } from 'pg';
import type { ReviewDiscoveryOrigin } from './review-discovery-events.ts';
import type { IndexedReview, ReviewDiscoverySource } from './review-discovery.ts';
/** A receiving position orders invalidations, never native content revisions. */
export type ReviewDiscoveryChange = Readonly<{
    id: string;
    position: bigint;
    origin: ReviewDiscoveryOrigin;
}>;
export type ReviewDiscoveryChangePage = Readonly<{
    partition: number;
    /** Stable journal cut for this catch-up pass; pass it back on continuation. */
    through: bigint;
    /** Progress includes empty ranges. */
    after: bigint;
    next: bigint | null;
    changes: readonly ReviewDiscoveryChange[];
}>;
export type ReviewDiscoveryRefresh = Readonly<{
    partition: number;
    /** Search must serialize/CAS refresh application per receiving partition. */
    after: bigint;
    through: bigint;
    next: bigint | null;
    /** Native source observation, separate from the receiving journal frontier. */
    nativePosition: bigint;
    reviews: readonly IndexedReview[];
    removed: readonly string[];
}>;
/** Exact sparse identity journal. This is not another native population page or census.
 * A complete page proves receiving progress only, not that upstream effects are drained. */
export declare function readReviewDiscoveryChanges(pool: Pool, partition: number, after?: bigint, limit?: number, through?: bigint): Promise<ReviewDiscoveryChangePage>;
/** Search's refresh linkage: every examined identity has an explicit current upsert or
 * removal. Missing native rows and loss of disclosure are both removals. Failures throw,
 * leaving consumer progress unacknowledged. No historical event body is hydrated. */
export declare function refreshReviewDiscoveryChanges(source: ReviewDiscoverySource, page: ReviewDiscoveryChangePage): Promise<ReviewDiscoveryRefresh>;
