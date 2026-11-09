/** The public Search service entry. Implementation modules stay private behind this surface. */
export { CollectionDiscoverySummarySchema } from './collection-discovery-schema.ts';
export { DiscoveryPopulationCutChangedError, DiscoveryProducerCoverageError } from './operation-outcomes.ts';
export { readAccountContextBindings } from './account-context-native.ts';
export type { AccountDiscoverySource, AccountDiscoverySummary, AccountFrontier, AccountPage, AccountPageKey, AccountSnapshot, CharacterPersonDiscoveryContexts, DiscoveryAdapterSlot, DiscoveryConsumerCaptureInput, DiscoveryContextList, DiscoveryContextSubject, DiscoveryHit, DiscoveryKey, DiscoveryKindMetadata, DiscoveryMetadataKind, DiscoveryMetadataProducer, DiscoveryMetadataProducers, DiscoveryMetadataRecord, DiscoveryOwnerAdapter, DiscoveryOwnerAdapterSlots, DiscoveryProducerEntry, DiscoveryOwnerHit, DiscoveryOwnerKey, DiscoveryOwnerKind, DiscoveryOwnerMetadataSummary, DiscoveryOwnerRegistration, DiscoveryOmittedKind, DiscoveryOwnerSummary, DiscoveryPage, DiscoveryPublicOwnerKey, DiscoveryReadContext, DiscoveryRequest, DiscoverySearch, DiscoverySummary, DiscoveryUnionHit, DiscoveryUnionKey, DiscoveryUnionSummary, IndexedAccount, KindCountEvidence, MixedDiscoveryRequest, PublicCollectionDiscoverySummary, PublicReviewDiscoverySummary, PublicSpaceDiscoverySummary, } from './discovery-api.ts';
export type { DiscoveryFilterDocument } from '@rezics/filter';
export type { SerializableContinuation, Source, SourcePage } from './discovery-source-contract.ts';
export type { SubjectListingSource, SubjectSource } from './source.ts';
export type { IndexedStatement } from './source.ts';
export type { RelationFacetMatch } from './source.ts';
export type { SearchPlan } from './query.ts';
export type { PublicCanonicalCaptureInput, PublicFilterConsumerCapture, PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerJob, PublicFilterConsumerOperations, PublicFilterConsumerOperationsFactory, PublicFilterConsumerQuery, PublicFilterConsumerRefill, PublicFilterConsumerRepair, PublicFilterConsumerStatus, PublicFilterConsumerUnavailable, PublicFilterConsumerWindow, PublicFilterQueriedObservation, PublicSuggestionCaptureInput, PublicSuggestionQuery, } from './public-filter-consumer-contract.ts';
export type { CustodyCost, CustodyDefinition, CustodyExecution, CustodyFailure, CustodyFound, CustodyRegistration, CustodyRetained, CustodyRetainedDefinition, CustodyUse, NativePublicFilterRepairSettlement, PublicFilterRepairSettlementResult, } from './public-filter-custody-contract.ts';
export { observeComposedSlot, type ObservedSlotResult } from '../presentation/http/slot-observed.ts';
export { uniqueCanonicalRows } from '../presentation/slot-bodies.ts';
import type { OpenSearch } from './opensearch.ts';
export type { SearchDisclosureApplication } from './disclosure-application.ts';
export type { SearchCollectionSourceDeps, SearchLibraryScopePort, SearchScopeCollection, SearchScopeOrder, SearchScopeWorkOptions, } from './library-scope-port.ts';
export { createNativeLibraryScopeWork } from './adapters/index.ts';
/** Complete native application: one installed instance owns matching, owner hydration, concept admission and final disclosure. */
export declare function createNativeSearchDisclosure(search: OpenSearch): {
    checkHits: typeof import("./disclosure-application.ts").checkHits;
    discloseOwnerHits: typeof import("./disclosure-application.ts").discloseOwnerHits;
    revalidateOwnerCurrentSummaries: typeof import("./disclosure-application.ts").revalidateOwnerCurrentSummaries;
    finishDiscoveryDisclosure: typeof import("./disclosure-application.ts").finishDiscoveryDisclosure;
    prepareConceptFilter: typeof import("./disclosure-application.ts").prepareConceptDisclosure;
    currentText: (index: string) => {
        matchesText: (subject: import("./source.ts").IndexedSubject, query: import("@rezics/search-text").TextNode) => Promise<boolean>;
        matchesPrefix: (subject: import("./source.ts").IndexedSubject, prefix: string) => Promise<boolean>;
    };
};
