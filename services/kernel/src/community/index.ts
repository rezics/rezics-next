export { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';
export { createCommunityDeclaration, type CommunityDeclaration } from './declaration.ts';
/** Community-owned Space discovery producer entry. Source readiness and incarnation remain native. */
export { readSpaceDiscoverySummaries, spaceDiscoverySource } from './space-discovery.ts';
export type {
  IndexedSpace,
  SpaceDiscoveryDependencies,
  SpaceDiscoveryKey,
  SpaceDiscoverySnapshot,
  SpaceDiscoverySource,
  SpaceDiscoverySummary,
  SpaceDiscoveryTupleWitness,
  SpaceDiscoveryTupleWitnessInput,
  SpaceDiscoveryTupleSource,
} from './space-discovery.ts';
export type { SpaceDiscoveryDependencyReadiness } from './space-discovery-dependencies.ts';
export type { SpaceEntryPage, SpaceEntryPresentation } from './space-discovery-entry-contract.ts';
