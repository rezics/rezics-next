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
