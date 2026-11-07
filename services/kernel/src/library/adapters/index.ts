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

export { createNativeCollectionMutationPorts } from './collection-mutation.ts';

export {
  createNativeCollectionPublicationEpisodes,
  type NativeCollectionPublicationCommandPorts,
} from './collection-publication-command.ts';
export { readBuiltinPublicationRule } from '../builtin-materialization.ts';

export { retireNativeCollectionCapturePage } from '../native-source-custody.ts';
export { purgeSavedCollectionPage } from '../saved-collection-retention.ts';
export { admitCollectionPublicationStep } from '../collection-publication-work-admission.ts';
