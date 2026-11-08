import type { RatingVoteSemantic } from '../../rating/index.ts';
/** Native Semantic implementations for Rating's vote and counted-read application ports.
 * Construction is inert. Every operation retains the original Pool, actor and live executor transaction.
 * Disclosure uses the ordinary Subject reader, including both original and terminal authorization.
 */
export declare function createNativeRatingVoteSemantic(): RatingVoteSemantic;
