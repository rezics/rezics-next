import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createSearchScopeOrderApplication, searchLibraryScopePort } from './scope-application.ts';
import type { SearchLibraryScopePort } from './library-scope-port.ts';
import { readScopeWorkDefinition } from './scope-work-context.ts';
import {
  MEMBERS_PREPARATION_SOURCE_COST,
  MEMBERS_PREPARATION_SOURCE_PATHS,
  MEMBERS_PREPARATION_SOURCE_TERMS,
} from './scope-members-source-declaration.ts';

const sourceBound = (work: Readonly<WorkReceipt['used']>): Bound => declareBound({ ...work, engineRequests: 0 });
function ordinalPath() {
  return memoizedValue(ordinalPath, () => MEMBERS_PREPARATION_SOURCE_PATHS().ordinal);
}
function nativeOrdinal() {
  return memoizedValue(nativeOrdinal, () =>
    searchLibraryScopePort().source.ordinalPageBound(ordinalPath().rawOrdinalRowsMaximum),
  );
}
// Reuse the selected Source metadata envelope and Search body ceiling. They already include the two
// work-definition currentness reads and the reached current identity, owner-filter, and disclosure calls.
function ordinalTerms() {
  return memoizedValue(ordinalTerms, () => {
    const source = searchLibraryScopePort().source;
    return Object.freeze({
      metadataPrefix: MEMBERS_PREPARATION_SOURCE_TERMS().metadataPrefix,
      searchBody: MEMBERS_PREPARATION_SOURCE_TERMS().searchBody,
      collectionState: repeatBound(
        sourceBound(source.canonicalReceivingCost().state),
        ordinalPath().membersSnapshots,
      ),
      nativeOrdinal: repeatBound(sourceBound(nativeOrdinal().work), ordinalPath().rawOrdinalRowsMaximum),
      sourceTransaction: MEMBERS_PREPARATION_SOURCE_TERMS().sourceTransaction,
    });
  });
}
function ordinalCost() {
  return memoizedValue(ordinalCost, () => {
    const cost = sumBounds(...Object.values(ordinalTerms()));
    if (!withinCeiling(cost, MEMBERS_PREPARATION_SOURCE_COST()))
      throw new TypeError('Selected ordinal Source operation exceeds its existing Source declaration');
    return cost;
  });
}

/** Fixed selected-work schedule for one raw ordinal continuation. This bounds work; it grants no dispatch authority. */
export function SEARCH_SCOPE_ORDINAL_OPERATION() {
  return memoizedValue(SEARCH_SCOPE_ORDINAL_OPERATION, () =>
    Object.freeze({
      axes: BOUND_AXES,
      rawLimit: ordinalPath().rawOrdinalRowsMaximum,
      schedule: ordinalPath(),
      nativeStatement: Object.freeze({
        limit: nativeOrdinal().limit,
        requestBytes: nativeOrdinal().requestBytes,
        resultBytes: nativeOrdinal().resultBytes,
        work: sourceBound(nativeOrdinal().work),
      }),
      terms: ordinalTerms(),
      cost: ordinalCost(),
      ceiling: MEMBERS_PREPARATION_SOURCE_COST(),
    }),
  );
}

/** Bind the Search application orchestration to the installed Library capability. */
export function createSearchScopeOrder(config: Readonly<{
  pool: Pool;
  options: LeafOptions;
  clock: KernelClock;
  library?: SearchLibraryScopePort;
}>) {
  return createSearchScopeOrderApplication({
    ...config,
    library: config.library ?? searchLibraryScopePort(),
    readWorkDefinition: readScopeWorkDefinition,
    selectedOrdinalPage: () => SEARCH_SCOPE_ORDINAL_OPERATION().nativeStatement,
  });
}

export { sameScopeObservation } from './scope-application.ts';
export type {
  SearchScopeCollection,
  SearchScopeOrder,
  SearchScopeOrdinalPrefix,
} from './library-scope-port.ts';
