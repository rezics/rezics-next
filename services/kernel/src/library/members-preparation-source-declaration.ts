import { memoizedValue } from '../memoized.ts';
import { membersPreparationSourcePaths } from '../search/contract/index.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { CANONICAL_SOURCE_RECEIVING_COST } from './canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
import { MEMBERS_PREPARATION_BRANCH_COST, MEMBERS_PREPARATION_STEP_CEILING } from './members-preparation-cost.ts';
import { SELECTED_COST } from '../work/selected-runtime-cost.ts';

/** Selected Members Source declarations use the shared finite work dimensions. */
export function MEMBERS_PREPARATION_SOURCE_AXES() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_AXES, () => BOUND_AXES);
}
export type MembersPreparationSourceCost = Bound;

const asBound = (work: Readonly<WorkDimensions>): Bound => declareBound({ ...work, engineRequests: 0 });

export function MEMBERS_PREPARATION_SOURCE_PATHS() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_PATHS, () =>
    membersPreparationSourcePaths(COLLECTION_SOURCE_WORK_GROUP_LIMIT),
  );
}

function sourceStatesPerInvocation(): number {
  return Math.max(
    MEMBERS_PREPARATION_SOURCE_PATHS().id.membersSnapshots,
    MEMBERS_PREPARATION_SOURCE_PATHS().ordinal.membersSnapshots,
  );
}

/**
 * The admitted Source cap composes three independently declared pieces: Library's fixed metadata prefix,
 * the bounded Search execution body, and each same-client Collection state revalidation. Search keeps its
 * existing per-operation ceilings; the static Source declaration does not allocate or refund those ceilings.
 * A reached rollback is included alongside the ordinary transaction envelope.
 */
function metadataPrefix() {
  return memoizedValue(metadataPrefix, () => asBound(MEMBERS_PREPARATION_BRANCH_COST.sourceMetadata));
}
function searchBody() {
  return memoizedValue(searchBody, () => asBound(MEMBERS_PREPARATION_STEP_CEILING));
}
function collectionState() {
  return memoizedValue(collectionState, () =>
    repeatBound(CANONICAL_SOURCE_RECEIVING_COST().state, sourceStatesPerInvocation()),
  );
}
function collectionPrefix() {
  return memoizedValue(collectionPrefix, () =>
    repeatBound(
      sumBounds(
        CANONICAL_SOURCE_RECEIVING_COST().seek,
        CANONICAL_SOURCE_RECEIVING_COST().group(MEMBERS_PREPARATION_SOURCE_PATHS().id.sourceGroupRowsPerQueryMaximum),
      ),
      MEMBERS_PREPARATION_SOURCE_PATHS().id.candidatePrefixMaximum,
    ),
  );
}
function sourceTransaction() {
  return memoizedValue(sourceTransaction, () => sumBounds(SELECTED_COST().transaction, SELECTED_COST().rollback));
}

export function MEMBERS_PREPARATION_SOURCE_TERMS() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_TERMS, () =>
    Object.freeze({
      metadataPrefix: metadataPrefix(),
      searchBody: searchBody(),
      collectionState: collectionState(),
      collectionPrefix: collectionPrefix(),
      sourceTransaction: sourceTransaction(),
    }),
  );
}

export function MEMBERS_PREPARATION_SOURCE_COST() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_COST, () =>
    sumBounds(metadataPrefix(), searchBody(), collectionState(), collectionPrefix(), sourceTransaction()),
  );
}

export function MEMBERS_PREPARATION_SOURCE_DECLARATION() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_DECLARATION, () =>
    Object.freeze({
      status: 'complete' as const,
      axes: MEMBERS_PREPARATION_SOURCE_AXES(),
      cost: MEMBERS_PREPARATION_SOURCE_COST(),
      terms: MEMBERS_PREPARATION_SOURCE_TERMS(),
      paths: MEMBERS_PREPARATION_SOURCE_PATHS(),
    }),
  );
}
