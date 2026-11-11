/** Content-owned discovery producer entry. Search supplies no author or review eligibility claims. */
export type { AvatarSummary } from './avatar.ts';
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
export { createRealmSubjectSearchSource } from './realm-subject-search.ts';
export type { RealmSubjectSource } from './realm-subject-source.ts';
export { readFences } from './source-fences.ts';
export type { SourceFenceTuple } from './source-fences.ts';

/** Explicit local composition only; production servers do not mount this transport. */
export { developmentMediaHandler } from './media-local-http.ts';

export { createHostedCatalogue, reviseHostedCatalogue, publishHostedCatalogue } from './hosted-chapters-commands.ts';
export type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
export {
  readHostedCatalogue,
  listHostedChildren,
  navigateHostedChapters,
  resolveHostedOccurrence,
} from './hosted-chapters-reads.ts';
export { listOwnHostedCatalogues, readOwnHostedCatalogue } from './hosted-chapters-owner.ts';
export type {
  HostedCreateInput,
  HostedReviseInput,
  HostedPublishInput,
  HostedPlacement,
  HostedChapterTarget,
  HostedReadSelection,
  HostedChildrenInput,
  HostedNavigationInput,
  HostedCommandContext,
  HostedCommandValue,
  HostedRevisionView,
  HostedOccurrenceView,
  HostedPageView,
  HostedResolutionView,
  HostedOwnerInventoryScope,
  HostedOwnerInventoryInput,
  HostedOwnerInventoryEntry,
  HostedOwnerInventoryView,
} from './hosted-chapters-model.ts';
