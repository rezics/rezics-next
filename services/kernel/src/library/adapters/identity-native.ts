/** Native identity bound adapter. Wraps the installed SQL catalog at composition. */

import type { IdentityNativeCapability, IdentityWorkHandle } from '../contract/index.ts';
import type { NativeCollectionWork } from '../collection-source-work.ts';
import {
  declareNativeIdentitySourceBasisStatements,
  isLibraryIdentityFullPartitionSQL,
  isNativeIdentitySourceBasisSQL,
  libraryIdentityJobSizeSQL,
  libraryIdentityNativeOperationBound,
  libraryIdentityNativeOperationFootprint,
  libraryIdentitySelectedFootprint,
  libraryIdentitySelectedOperationBound,
  nativeIdentitySourceBasisBound,
  nativeIdentitySourceBasisFootprint,
} from '../identity-native-bounds.ts';

export function createNativeIdentityBoundsAdapter(): IdentityNativeCapability {
  return {
    bound(sql, values, work?: IdentityWorkHandle) {
      return libraryIdentityNativeOperationBound(sql, values, work as NativeCollectionWork | undefined);
    },
    footprint: libraryIdentityNativeOperationFootprint,
    selectedFootprint: libraryIdentitySelectedFootprint,
    isFullPartitionSQL: isLibraryIdentityFullPartitionSQL,
    isSourceBasisSQL: isNativeIdentitySourceBasisSQL,
    sourceBasisFootprint: nativeIdentitySourceBasisFootprint,
    sourceBasisBound: nativeIdentitySourceBasisBound,
    selectedBound: libraryIdentitySelectedOperationBound,
    basisStatements: declareNativeIdentitySourceBasisStatements,
    jobSizeSQL: libraryIdentityJobSizeSQL,
  };
}
