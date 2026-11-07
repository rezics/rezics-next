/** Library contract barrel. Cross-module callers import this entry or work-dimensions.ts. */

export type { WorkAllowance, WorkDimensions, WorkReceipt } from './work-dimensions.ts';
export { libraryActorOf } from './actors.ts';
export type { GrantedAccount, LibraryAccountActor, LibraryActor, LibraryAnonymousActor } from './actors.ts';
export {
  CANONICAL_SOURCE_RAW_KEY_LIMIT,
  COLLECTION_SOURCE_DRIVER_COUNT,
  COLLECTION_SOURCE_WORK_GROUP_LIMIT,
  ORDINARY_COLLECTION_PAGE_LIMIT,
  ORDINARY_COLLECTION_PREFIX_ROUNDS,
  nativeEvidence,
  preparedSource,
} from './source.ts';
export type {
  CanonicalCollectionCandidate,
  CanonicalCollectionPrefix,
  CollectionAliasProgress,
  CollectionSource,
  CollectionSourceAfter,
  CollectionSourceAuthority,
  CollectionSourceBasis,
  CollectionSourceCall,
  CollectionSourceContext,
  CollectionSourceDriverOrdinal,
  CollectionSourceEvidence,
  CollectionSourceObservation,
  CollectionSourceStamp,
  CollectionSubjectMembership,
  ContainsCollectionSubject,
  NativeIdentityBasis,
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  NativeOrdinalRow,
  PrepareCollectionSource,
  PreparedCollectionSource,
  RawOrdinalCollectionPrefix,
  RawStoredCollectionPrefix,
  ReadRawOrdinalCollectionPrefix,
} from './source.ts';
export type {
  MembershipPage,
  NestedAdmissionAccount,
  NestedAdmissionTerm,
  OccurrenceDraft,
  OrderedOccurrence,
} from './membership.ts';
export {
  SESSION_LIMITS,
  emptyProgressOperationCatalog,
  emptySessionWork,
} from './progress-operations.ts';
export type {
  ProgressAccessSqlCatalog,
  ProgressCommandSqlCatalog,
  ProgressOperationAdmission,
  ProgressOperationApplication,
  ProgressOperationCatalog,
  ProgressSemanticSqlCatalog,
  ProgressSessionSqlCatalog,
  ProgressShelfStatement,
  ProgressSqlDescriptor,
  SessionCommandDeclaration,
  SessionCommandOriginal,
  SessionOperationKind,
  SessionReadDeclaration,
  SessionReadInput,
  SessionReadKind,
  SessionSqlKind,
  SessionWork,
} from './progress-operations.ts';
export type {
  CollectionPublicationNativeCapability,
  CollectionRuleAuthorityCapability,
  AuthorizationCapability,
  AuthorizationDecision,
  ContentPublicationCapability,
  IdentityDisclosureCapability,
  IdentityNativeCapability,
  IdentityNativeCatalog,
  IdentitySqlWork,
  IdentityWorkHandle,
  LibraryCapabilities,
  LibraryCoverCredit,
  LibraryCoverSummary,
  LibraryRelease,
  PreparedSearchScope,
  QueryText,
  SearchFilterLeafKind,
  SearchPreparationCapability,
  SourceCaptureCapability,
} from './capabilities.ts';
export type {
  EntryProgressAdmission,
  LibraryDomain,
  MemberPreparationResult,
  OwnerQueryInput,
  OwnerQueryOpen,
  PublicationAdmissionResult,
  SourceCaptureResult,
} from './results.ts';

export {
  FollowCountUnavailableError,
  FollowCountTargetAbsentError,
  FollowCountReadRefusedError,
  FOLLOW_COUNT_ACCOUNT_EVENTS,
} from './follow-counts.ts';
export type {
  CountKey,
  CountReplacement,
  CountDestination,
  FollowTargetType,
  FollowCountTarget,
  FollowCountPage,
  FollowCountHealthObservation,
  FollowCountReadPorts,
  FollowCountReads,
  FollowCountDeliveryPorts,
  FollowCountPartitionPorts,
  FollowCountRuntime,
} from './follow-counts.ts';

export type {
  CollectionVisibility,
  CollectionState,
  CollectionRow,
  Collection,
  CollectionDraft,
  CollectionChanges,
  CollectionMemberRow,
  CollectionMember,
  CollectionMemberDraft,
  MemberPosition,
  MemberNeighbors,
  MemberPage,
  MemberReordering,
} from './collection.ts';

export * from './collection-history.ts';
export type {
  CollectionMetadataHistorySqlPlan,
  CollectionMetadataHistoryCapturePlan,
  CollectionWriteContext,
  CollectionHistoryInitializeInput,
  CollectionHistoryCaptureInput,
  CollectionMutationPorts,
  CollectionMutationApplication,
} from './collection-mutation.ts';

export type {
  CollectionCleanupPage,
  CollectionDeletionKey,
  CollectionRetirementEpisode,
  CollectionRetentionNativeCapability,
} from './collection-mutation.ts';

export const COLLECTION_PUBLICATION_COMMAND = 'library.collection.publication.begin';
export const COLLECTION_PUBLICATION_WORKFLOW = 'library.collectionPublication';

export type { PreparationWorkCapability, PreparationSourcePrefix, ScopeWorkCapability } from './preparation-work.ts';

export { OWNER_FILTER_CLOSURE_REFERENCE_LIMIT, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT } from './preparation-limits.ts';
