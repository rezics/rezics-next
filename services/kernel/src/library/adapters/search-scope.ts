/** Search preparation adapter. Composition supplies Search; this file imports none of it. */

import type { PreparedSearchScope, SearchFilterLeafKind, SearchPreparationCapability } from '../contract/index.ts';

export type SearchPreparationAdapterPorts = Readonly<{
  prepareScope: SearchPreparationCapability['prepareScope'];
  filterLeaves(filter: unknown): readonly SearchFilterLeafKind[];
}>;

export function createSearchPreparationAdapter(ports?: SearchPreparationAdapterPorts): SearchPreparationCapability {
  return {
    prepareScope(input) {
      if (!ports) throw new TypeError('The registered Search service is not configured.');
      return ports.prepareScope(input);
    },
    ownerFilterHasOwnerLeaf(filter) {
      return ports?.filterLeaves(filter).includes('owner') ?? false;
    },
    filterLeaves(filter) {
      return ports?.filterLeaves(filter) ?? [];
    },
  };
}

export type { PreparedSearchScope };
