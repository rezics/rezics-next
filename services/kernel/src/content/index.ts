/** Content-owned discovery producer entry. Search supplies no author or review eligibility claims. */
export type { AvatarSummary } from './avatar.ts';
export { createReviewDiscoverySource } from './review-discovery.ts';
export type {
  IndexedReview,
  NativeReviewDiscoverySource,
  ReviewDiscoveryContinuation,
  ReviewDiscoveryCount,
  ReviewDiscoveryHomeObservation,
  ReviewDiscoveryHydration,
  ReviewDiscoveryIncompletePage,
  ReviewDiscoveryPage,
  ReviewDiscoveryPageKey,
  ReviewDiscoveryPopulationPage,
  ReviewDiscoverySnapshot,
  ReviewDiscoverySource,
  ReviewDiscoverySummary,
} from './review-discovery.ts';
export type { ReviewDiscoveryRefresh } from './review-discovery-changes.ts';
export { REVIEW_DISCOVERY_PAGE_LIMIT, REVIEW_DISCOVERY_READ_LIMIT } from './review-discovery.ts';
