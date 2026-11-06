/** Identity-native application. Catalog values are bound at composition; arithmetic is core. */

import type { IdentityNativeCapability, IdentityNativeCatalog, IdentityWorkHandle } from '../contract/index.ts';
import { createIdentityNativeBounds } from '../core/index.ts';

export function createIdentityNativeApplication(catalog: IdentityNativeCatalog): IdentityNativeCapability {
  const bounds = createIdentityNativeBounds(catalog);
  return {
    bound(sql, values, work?: IdentityWorkHandle) {
      return bounds.bound(sql, values, work);
    },
    footprint: bounds.footprint,
    selectedFootprint: bounds.selectedFootprint,
    isFullPartitionSQL: bounds.isFullPartitionSQL,
    isSourceBasisSQL: bounds.isSourceBasisSQL,
    sourceBasisFootprint: bounds.sourceBasisFootprint,
    sourceBasisBound: bounds.sourceBasisBound,
    selectedBound: bounds.selectedBound,
    basisStatements: bounds.basisStatements,
    jobSizeSQL: bounds.jobSizeSQL,
  };
}
