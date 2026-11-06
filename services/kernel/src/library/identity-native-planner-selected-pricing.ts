/** Compatibility adapter for existing custody and conformance callers.
 * Core arithmetic plus the adapter catalog own the declarations; identity-native-bounds.ts is the facade.
 */
export {
  declareNativeIdentitySourceBasisStatements,
  isNativeIdentitySourceBasisSQL,
  libraryIdentitySelectedFootprint,
  nativeIdentityPartitionQuery,
  nativeIdentitySourceBasisFootprint,
} from './identity-native-bounds.ts';
