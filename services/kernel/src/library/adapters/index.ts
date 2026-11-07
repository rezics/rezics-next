/** Native SQL and foreign Library adapters. Composition is the only production importer. */

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
export { createNativeSourceCaptureAdapter } from './native-source.ts';

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
