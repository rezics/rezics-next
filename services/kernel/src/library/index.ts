/** Library-owned discovery producer entry. Search adapts these ports without taking Collection authority. */
export type { FollowDiscovery } from './follow-discovery.ts';
export type { ViewerFactsPage } from './viewer-facts.ts';
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
  PublicCollectionDiscoverySummary,
} from './collection-discovery-summaries.ts';
