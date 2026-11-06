/** Native identity bound adapter. Catalog texts plus core arithmetic, bound at composition. */

import type { IdentityNativeCapability, IdentityWorkHandle } from '../contract/index.ts';
import { createIdentityNativeBounds } from '../core/index.ts';
import { createIdentityNativeCatalog } from './identity-statements.ts';

export function createNativeIdentityBoundsAdapter(): IdentityNativeCapability {
  const bounds = createIdentityNativeBounds(createIdentityNativeCatalog());
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
