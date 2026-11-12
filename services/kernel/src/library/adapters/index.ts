/** Native SQL and foreign Library adapters. Composition is the only production importer. */

export { createProgressOperationCatalog, PROGRESS_MEANING_SQL, PROGRESS_REFRESH_SQL } from './progress-statements.ts';
export {
  continuePageSchema,
  createContinuePageAdapter,
  type DisclosedContinuePage,
  type DisclosedContinueSubject,
} from './continue-page.ts';

export { createAuthorizationAdapter, type AuthorizationAdapterPorts } from './authorization.ts';
export { createIdentityDisclosureAdapter, type IdentityDisclosureAdapterPorts } from './identity-disclosure.ts';
export { createNativeIdentityBoundsAdapter } from './identity-native.ts';
export {
  createIdentityNativeCatalog,
  libraryIdentityJobSizeSQL,
  nativeIdentityPartitionQuery,
} from './identity-statements.ts';
export { createSearchPreparationAdapter, type SearchPreparationAdapterPorts } from './search-scope.ts';
export { createContentPublicationAdapter, type ContentPublicationAdapterPorts } from './publication-foreign.ts';
export { createNativePublicOutputAdapter, type NativePublicOutputAdapterPorts } from './native-public-output.ts';
export { observeNativePublicCollectionOutput } from '../collection-source-native.ts';
export { createNativeSourceCaptureAdapter } from './native-source.ts';
export { readNativeCollectionScopeIdentity } from '../collection-source-native.ts';
export {
  createScopedSearchLibraryOperations,
  type ScopedSearchLibraryOperations,
  type ScopedCollectionSourceDeps,
  type CollectionSourceWorkState,
  type CollectionSourceRawKey,
} from './scoped-source.ts';
export { createCollectionSource } from '../collection-source.ts';
export { nativeCollectionOrdinalPageBound } from '../collection-source-native.ts';
export type { NativeCollectionOrdinalPageBound } from '../collection-source-native.ts';
export { createMembersPreparation } from '../members-preparation.ts';
export type { MembersPreparationWorkDefinition, PreparationLocator } from '../members-preparation.ts';
export { createMembersPreparationAdapter } from './members-preparation.ts';
export type { LibraryMembersPreparationRuntime, MembersPreparationStoreDependencies } from '../domain.ts';
export { NativeCollectionWork } from '../collection-native-work.ts';
export type { NativeSourceIdentity } from '../native-source-custody.ts';
export { CANONICAL_SOURCE_RECEIVING_COST } from '../canonical-source-bounds.ts';

export { createNativeFollowCountReads, type NativeFollowCountReadPorts } from './follow-count-reads.ts';

export { createNativeCollectionMutationPorts } from './collection-mutation.ts';

export {
  createNativeCollectionPublicationEpisodes,
  type NativeCollectionPublicationCommandPorts,
} from './collection-publication-command.ts';
export { readBuiltinPublicationRule } from '../builtin-materialization.ts';

export { retireNativeCollectionCapturePage } from '../native-source-custody.ts';
export { purgeSavedCollectionPage } from '../saved-collection-retention.ts';
export { admitCollectionPublicationStep } from '../collection-publication-work-admission.ts';

export type { PreparationSourcePrefix } from '../contract/index.ts';
export type {
  NativePreparationWorkFactory,
  NativePreparationWork,
  NativePreparationPrefixRequest,
  NativeScopeWork,
  NativeScopeWorkDefinition,
  MembersPreparationWorkContext,
  CollectionKindPreparationWorkContext,
  CollectionPublicationWorkContext,
  ScopeWorkContext,
} from './preparation-work.ts';
export {
  MEMBERS_PREPARATION_SOURCE_AXES,
  MEMBERS_PREPARATION_SOURCE_PATHS,
  MEMBERS_PREPARATION_SOURCE_TERMS,
  MEMBERS_PREPARATION_SOURCE_COST,
  MEMBERS_PREPARATION_SOURCE_DECLARATION,
  type MembersPreparationSourceCost,
} from '../members-preparation-source-declaration.ts';

export {
  createNativeCopyPorts,
  type NativeCopyConfig,
  type NativeCopyTypes,
  type NativeCopyProducers,
} from './copies.ts';
export { createNativeLibraryPresentation } from './presentation.ts';
export type {
  NativeLibraryPresentation,
  NativeLibraryPresentationPorts,
  LibraryPresentationDependencies,
} from './presentation.ts';

/** Copy construction leaves used only by composition. */
export { readLibraryProfileSourceObservation, readLibraryProfileAnchor } from '../profile-source.ts';
export { createNativeCopyProducers } from './copy-producers.ts';
export { createCopyOperationPlans } from '../copy-operation-bounds.ts';
export type { NativeCopyDefinitions, CopyProfileSource } from '../copy-model.ts';
export { createLibraryCommandRunner } from '../command-support.ts';
export {
  createHostedReadingCommands,
  createHostedReadingReads,
  readHostedReadingExportPage,
} from '../hosted-reading.ts';
export { hostedReadingRoutes } from '../hosted-reading-routes.ts';
export { bindHostedReadingPort, requireHostedReadingPort } from '../hosted-reading-bind.ts';

export { createFollowActivitySource } from '../follow-activity.ts';
export { createCollectionReads } from '../collection-reads.ts';
export type { ViewerPersonalActionsReader } from '../viewer-personal-actions.ts';
export type { CollectionResourceView } from '../collection-reads.ts';
