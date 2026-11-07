/** Search-owned vocabulary for the installed Library-backed scoped Source capability. */
import type { CollectionAliasProgress, CollectionSourceObservation, PreparedCollectionSource } from '../library/collection-source.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { NativeOrdinalFrontier, NativeOrdinalKey, RawOrdinalCollectionPrefix } from '../library/collection-source-order.ts';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { MembersPreparationWorkDefinition, PreparationLocator } from '../library/members-preparation.ts';
import type { createCollectionSource } from '../library/collection-source.ts';
import type { readCollectionSourceWorkGroup, readCollectionSourceWorkState } from '../library/collection-source-work-native.ts';
import type { CANONICAL_SOURCE_RECEIVING_COST } from '../library/canonical-source-bounds.ts';
import type { nativeCollectionOrdinalPageBound } from '../library/collection-source-native.ts';
import type { createMembersPreparation } from '../library/members-preparation.ts';

/** Native source locator only. It does not grant authority or define a public Search sort. */
export type SearchScopeOrder =
  | Readonly<{ kind: 'id'; source?: NativeSourceIdentity }>
  | Readonly<{ kind: 'ordinal'; source: NativeSourceIdentity }>;

export type SearchScopeOrdinalPrefix = Readonly<{
  subjects: readonly Readonly<{ subject: string; after: NativeOrdinalKey }>[];
  frontier: NativeOrdinalFrontier;
  exhausted: boolean;
  observation: CollectionSourceObservation;
  work: WorkReceipt;
}>;

export type SearchScopeCollection = Readonly<{
  order: SearchScopeOrder;
  source: PreparedCollectionSource;
  observation: CollectionSourceObservation;
}>;

/** The complete Library capability used by Search scope preparation and ordered execution. */
export type SearchLibraryScopePort = Readonly<{
  source: Readonly<{
    create: typeof createCollectionSource;
    readWorkState: typeof readCollectionSourceWorkState;
    readWorkGroup: typeof readCollectionSourceWorkGroup;
    canonicalReceivingCost: typeof CANONICAL_SOURCE_RECEIVING_COST;
    collectionWorkGroupLimit: number;
    ordinalPageBound: typeof nativeCollectionOrdinalPageBound;
  }>;
  members: Readonly<{
    createNativeCollectionWork: (allowance: WorkAllowance, deadline: number) => NativeCollectionWork;
    createPreparation: typeof createMembersPreparation;
  }>;
}>;

export type SearchNativeCollectionWork = NativeCollectionWork;
export type {
  CollectionAliasProgress,
  MembersPreparationWorkDefinition,
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  PreparationLocator,
  RawOrdinalCollectionPrefix,
};
