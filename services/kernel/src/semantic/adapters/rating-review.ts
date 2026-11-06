import type { Pool } from 'pg';
import { memoizedValue } from '../../memoized.ts';
import { VoteReviewStaleError, VoteReviewUnavailableError } from '../../rating/own-votes-review.ts';
import type { RatingReviewPort } from '../contract/domain-ports.ts';
import { resolvedSemanticDomain } from './registry.ts';

export { VoteReviewStaleError, VoteReviewUnavailableError };

/** Rating-owned stale and unavailable errors. Composition binds this port; inward code never imports Rating. */
export function nativeRatingReview(): RatingReviewPort {
  return memoizedValue(nativeRatingReview, () =>
    Object.freeze({
      subjectChanged: () => new VoteReviewStaleError('subject_changed'),
      identityEpochChanged: () => new VoteReviewStaleError('identity_epoch_changed'),
      pending: () => new VoteReviewUnavailableError('identity_pending'),
      moved: (home: number) => {
        const error = new VoteReviewUnavailableError('identity_observation_unavailable');
        Object.assign(error, { home });
        return error;
      },
      absent: () => new VoteReviewUnavailableError('identity_observation_unavailable'),
      undisclosed: () => new VoteReviewUnavailableError('identity_observation_unavailable'),
      unavailable: () => new VoteReviewUnavailableError('identity_observation_unavailable'),
      foreignControl: () => new VoteReviewUnavailableError('atomic_guard_unavailable'),
    }),
  );
}

export function ratingReviewOf(pool?: Pool): RatingReviewPort {
  return resolvedSemanticDomain(pool)?.ports.ratingReview ?? nativeRatingReview();
}
