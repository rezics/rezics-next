/** Search-owned Library capabilities used by scoped Source, Members and preparation. */
type LibraryOwnerFilterApi = Pick<typeof import('../library/owner-filter.ts'), 'admitCollectionMemberQuery' | 'leafProvider'>;
type LibraryOwnerFilterPlanApi = Pick<typeof import('../library/owner-filter-plan.ts'), 'bindOwnerFilterRead' | 'readOwnerFilterCandidate' | 'readOwnerFilterCandidateClosure'>;
type LibraryOwnerFilterClosureApi = Pick<typeof import('../library/owner-filter-native-closure.ts'), 'readNativeOwnerFilterCandidateFacts'>;
type LibraryOwnerFilterNativeApi = Pick<typeof import('../library/owner-filter-native-binding.ts'), 'withOwnerFilterNativeRead' | 'readNativeOwnerFilterBindingFence'>;
type LibraryCustodyApi = Pick<typeof import('../library/native-source-custody.ts'), 'createNativeLibrarySourceCustody'>;
type LibraryKindAdmissionApi = Pick<typeof import('../library/collection-kind-work-admission.ts'), 'admitCollectionKindPreparationStep' | 'bindCollectionKindPreparationStep' | 'readCollectionKindWorkDefinition'>;
type LibraryPublicationAdmissionApi = Pick<typeof import('../library/collection-publication-work-admission.ts'), 'admitCollectionPublicationStep' | 'readCollectionPublicationWorkDefinition'>;
type LibraryCollectionDiscoveryApi = Pick<typeof import('../library/collection-discovery-summaries.ts'), 'readPublicCollectionDiscoverySummaries'>;
export type SearchLibraryNativePort = Readonly<LibraryOwnerFilterApi & LibraryOwnerFilterPlanApi & LibraryOwnerFilterClosureApi & LibraryOwnerFilterNativeApi & LibraryCustodyApi & LibraryKindAdmissionApi & LibraryPublicationAdmissionApi & LibraryCollectionDiscoveryApi>;
export {};
