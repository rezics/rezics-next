import type { Pool } from 'pg';
import { VoteReviewStaleError, VoteReviewUnavailableError } from '../../rating/own-votes-review.ts';
import type { RatingReviewPort } from '../contract/domain-ports.ts';
export { VoteReviewStaleError, VoteReviewUnavailableError };
/** Rating-owned stale and unavailable errors. Composition binds this port; inward code never imports Rating. */
export declare function nativeRatingReview(): RatingReviewPort;
export declare function ratingReviewOf(pool?: Pool): RatingReviewPort;
