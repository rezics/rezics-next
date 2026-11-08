/** Library-owned discovery producer entry. Search adapts these ports without taking Collection authority. */
export type { FollowDiscovery } from './follow-discovery.ts';
export {
  prepareViewerFacts,
  readViewerFacts,
  readViewerFactsPage,
  viewerFactsCurrent,
  viewerFactsResponseSchema,
} from './viewer-facts.ts';
export type { PreparedViewerFacts, ViewerFact, ViewerFactInput, ViewerQuestion } from './viewer-facts.ts';
export type { ViewerFactsPage, ViewerPersonalActionsPage, PublicCollectionDiscoverySummary } from './contract/index.ts';
export type { ViewerPersonalActionsReader } from './viewer-personal-actions.ts';
export { viewerPersonalActionsResponseSchema } from './viewer-personal-actions-schema.ts';
export { publicCollectionDiscoverySource } from './collection-discovery-source.ts';
export type {
  CollectionDiscoveryCensus,
  CollectionDiscoveryIndexableValue,
  CollectionDiscoveryItem,
  CollectionDiscoveryKey,
  CollectionDiscoveryPage,
  CollectionDiscoveryPosition,
  CollectionDiscoverySnapshot,
  CollectionDiscoverySource,
} from './collection-discovery-source.ts';
export { readPublicCollectionDiscoverySummaries } from './collection-discovery-summaries.ts';
export type {
  PublicCollectionDiscoveryContext,
  PublicCollectionDiscoveryDependencies,
  PublicCollectionDiscoveryRequest,
  PublicCollectionDiscoveryResult,
} from './collection-discovery-summaries.ts';
