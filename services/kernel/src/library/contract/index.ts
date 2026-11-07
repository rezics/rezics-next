/** Library contract barrel. Cross-module callers import this entry or work-dimensions.ts. */

export type { WorkAllowance, WorkDimensions, WorkReceipt } from './work-dimensions.ts';
export type * from './native-public-output.ts';
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
  CanonicalSourceReceivingCost,
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
  CollectionSourceRawKey,
  CollectionSourceStamp,
  CollectionSubjectMembership,
  ContainsCollectionSubject,
  NativeAccountSourceIdentity,
  NativeCollectionOrdinalPageBound,
  NativeIdentityBasis,
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  NativeOrdinalRow,
  NativeOutputActivation,
  NativePublicOutputIdentity,
  NativeSourceIdentity,
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
export { SESSION_LIMITS, emptyProgressOperationCatalog, emptySessionWork } from './progress-operations.ts';
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
  CollectionAuthorizationPreparation,
  CollectionListFilter,
  SpecializeCollectionListInput,
} from './collection-policy.ts';
export { EMPTY_COLLECTION_AUTHORIZATION_PREPARATION } from './collection-policy.ts';
export type {
  CollectionPublicationNativeCapability,
  CollectionRuleAuthorityCapability,
  AuthorizationCapability,
  AuthorizationDecision,
  CollectionSourceFactory,
  CollectionSourceLimits,
  CollectionSourceWorkCapability,
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
  MembersWorkDefinitionCapability,
  NativeCollectionWorkFactory,
  NativeCollectionWorkHandle,
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

export type {
  MembersWorkDefinition,
  PreparationLocator,
  PreparationWorkCapability,
  PreparationSourcePrefix,
  ScopeWorkCapability,
} from './preparation-work.ts';

export { OWNER_FILTER_CLOSURE_REFERENCE_LIMIT, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT } from './preparation-limits.ts';

export * from './copy-values.ts';
export * from './copy-application.ts';
export * from './copy-operations.ts';
export * from './presentation.ts';
export type { BuiltinMemberCapability, BuiltinMemberOptions } from './builtin-presentation.ts';

export type {
  ContinueActor,
  ContinueListQuery,
  ContinuePage,
  ContinueProgressPresentation,
  ContinueProgressRecording,
  ContinueReads,
  ContinueSession,
  ContinueSessionMeasure,
  ContinueSubject,
  ContinueSubjectFacts,
} from './continue.ts';

export {
  ENTRY_STATES,
  type LegacyEntryState,
  isLegacyEntryState,
  isShelfEntryState,
  SHELF_ORDERS,
  SHELF_DIRECTIONS,
  type ShelfOrder,
  type ShelfDirection,
  SHELF_DEFAULT_ORDER,
  MAX_SHELF_PAGE_SIZE,
  DEFAULT_SHELF_PAGE_SIZE,
  type ShelfQuery,
  type ShelfCursorBinding,
  normalizeShelfQuery,
  shelfCursorBinding,
  shelfTypeCursorBinding,
  SHELF_TYPE_CHUNK_BYTES,
  SHELF_TYPE_EDGE_BATCH,
  SHELF_TYPE_RESPONSE_BYTES,
  SHELF_LIST_ACTION,
  SHELF_PROGRESS_ACTION,
  SHELF_PROGRESS_GATE,
} from './shelf-query.ts';

export {
  type InitialShelfInputs,
  initialShelfReadiness,
  counterWriteMode,
  EMPTY_SHELF_GENERATION,
  SHELF_BACKFILL_PHASES,
  SHELF_COUNTER_PHASES,
  SHELF_PURGE_PHASES,
  type ShelfMaintenancePhase,
  type ShelfMaintenanceKind,
  type ShelfOwner,
  type ShelfMaintenanceCursor,
} from './shelf-maintenance.ts';

export {
  BULK_PAGE_LIMIT,
  BULK_SEGMENT_PAGES,
  BULK_EXECUTION_HOURS,
  BULK_RESULTS_HOURS,
  BULK_COMMAND_DEADLINE_MS,
} from './bulk-limits.ts';
