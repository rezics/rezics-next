/** Concrete binding for Search's consumer-owned scoped Collection capability. */
import { CANONICAL_SOURCE_RECEIVING_COST } from '../library/canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from '../library/canonical-source-limits.ts';
import { createCollectionSource } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import {
  readCollectionSourceWorkGroup,
  readCollectionSourceWorkState,
} from '../library/collection-source-work-native.ts';
import { nativeCollectionOrdinalPageBound } from '../library/collection-source-native.ts';
import { createMembersPreparation } from '../library/members-preparation.ts';
import type { WorkAllowance } from '../library/contract/work-dimensions.ts';
import type { SearchLibraryScopePort } from '../search/library-scope-port.ts';

const searchLibraryScopePort: SearchLibraryScopePort = Object.freeze({
  source: Object.freeze({
    create: createCollectionSource,
    readWorkState: readCollectionSourceWorkState,
    readWorkGroup: readCollectionSourceWorkGroup,
    canonicalReceivingCost: CANONICAL_SOURCE_RECEIVING_COST,
    collectionWorkGroupLimit: COLLECTION_SOURCE_WORK_GROUP_LIMIT,
    ordinalPageBound: nativeCollectionOrdinalPageBound,
  }),
  members: Object.freeze({
    createNativeCollectionWork: (allowance: WorkAllowance, deadline: number) =>
      new NativeCollectionWork(allowance, deadline),
    createPreparation: createMembersPreparation,
  }),
});

export function createSearchLibraryScopePort(): SearchLibraryScopePort {
  return searchLibraryScopePort;
}
