/** Identity-native application. Catalog values are bound at composition; arithmetic is core. */

import type { IdentityNativeCapability, IdentityNativeCatalog, IdentityWorkHandle } from '../contract/index.ts';
import { createIdentityNativeBounds, identityBasisBindValues } from '../core/index.ts';

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
    basisStatements() {
      return Object.freeze(
        catalog.basisQueries.map((query) => {
          const values = Object.freeze(identityBasisBindValues(query.params ?? []));
          const work = bounds.sourceBasisFootprint(query.sql, values);
          if (!work) throw new TypeError('Identity source-basis declaration is incomplete');
          return Object.freeze({ sql: query.sql, values, work, engineRequests: 0 as const });
        }),
      );
    },
    jobSizeSQL: bounds.jobSizeSQL,
  };
}
