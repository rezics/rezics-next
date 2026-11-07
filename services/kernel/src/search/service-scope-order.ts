import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createSearchScopeOrderApplication } from './scope-application.ts';
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

function ordinalPlan(library: SearchLibraryScopePort) {
  return memoizedValue(library.source.limits, () => {
    const source = library.source;
    const nativeOrdinal = source.limits.ordinalPageBound(ordinalPath().rawOrdinalRowsMaximum);
    const terms = Object.freeze({
      metadataPrefix: MEMBERS_PREPARATION_SOURCE_TERMS().metadataPrefix,
      searchBody: MEMBERS_PREPARATION_SOURCE_TERMS().searchBody,
      collectionState: repeatBound(sourceBound(source.limits.receivingCost.state), ordinalPath().membersSnapshots),
      nativeOrdinal: repeatBound(sourceBound(nativeOrdinal.work), ordinalPath().rawOrdinalRowsMaximum),
      sourceTransaction: MEMBERS_PREPARATION_SOURCE_TERMS().sourceTransaction,
    });
    const cost = sumBounds(...Object.values(terms));
    if (!withinCeiling(cost, MEMBERS_PREPARATION_SOURCE_COST()))
      throw new TypeError('Selected ordinal Source operation exceeds its existing Source declaration');
    return Object.freeze({
      axes: BOUND_AXES,
      rawLimit: ordinalPath().rawOrdinalRowsMaximum,
      schedule: ordinalPath(),
      nativeStatement: Object.freeze({
        limit: nativeOrdinal.limit,
        requestBytes: nativeOrdinal.requestBytes,
        resultBytes: nativeOrdinal.resultBytes,
        work: sourceBound(nativeOrdinal.work),
      }),
      terms,
      cost,
      ceiling: MEMBERS_PREPARATION_SOURCE_COST(),
    });
  });
}

/** Fixed selected-work schedule for one raw ordinal continuation. This bounds work; it grants no dispatch authority. */
export function SEARCH_SCOPE_ORDINAL_OPERATION(library: SearchLibraryScopePort) {
  return ordinalPlan(library);
}

/** Bind the Search application orchestration to the supplied Library capability. */
export function createSearchScopeOrder(
  config: Readonly<{
    pool: Pool;
    options: LeafOptions;
    clock: KernelClock;
    library: SearchLibraryScopePort;
  }>,
) {
  return createSearchScopeOrderApplication({
    pool: config.pool,
    options: config.options,
    clock: config.clock,
    library: config.library,
    readWorkDefinition: (work, options) => readScopeWorkDefinition(work, options),
    selectedOrdinalPage: () => SEARCH_SCOPE_ORDINAL_OPERATION(config.library).nativeStatement,
  });
}

export { sameScopeObservation } from './scope-application.ts';
export type { SearchScopeCollection, SearchScopeOrder, SearchScopeOrdinalPrefix } from './library-scope-port.ts';
