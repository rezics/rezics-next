import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import { CANONICAL_SOURCE_RECEIVING_COST } from '../library/canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from '../library/canonical-source-limits.ts';
import {
  MEMBERS_PREPARATION_BRANCH_COST,
  MEMBERS_PREPARATION_STEP_CEILING,
} from '../library/members-preparation-cost.ts';
import { SELECTED_COST } from '../work/selected-runtime-cost.ts';

/** Selected Members Source declarations use the shared finite work dimensions. */
export function MEMBERS_PREPARATION_SOURCE_AXES() {
  return memoizedValue(MEMBERS_PREPARATION_SOURCE_AXES, () => BOUND_AXES);
}
export type MembersPreparationSourceCost = Bound;

const asBound = (work: Readonly<WorkDimensions>): Bound => declareBound({ ...work, engineRequests: 0 });

/** Call counts from the real released Source path; id and ordinal are mutually exclusive. */
export const MEMBERS_PREPARATION_SOURCE_PATHS = Object.freeze({
  id: Object.freeze({
    definitionGetters: 15,
    membersSnapshots: 8,
    orderCurrentnessReads: 4,
    sourcePrepare: 1,
    sourcePrefix: 1,
    evaluatedSubjects: 1,
    candidatePrefixMaximum: 2,
    sourceSeekQueriesMaximum: 2,
    sourceGroupQueriesMaximum: 2,
    sourceGroupRowsPerQueryMaximum: COLLECTION_SOURCE_WORK_GROUP_LIMIT,
    closurePasses: 2,
    distinctGroupQueries: 1,
    terminalQueriesPerClosureMaximum: 49,
    factQueriesPerClosureMaximum: 50,
    ownerFactReadsPerClosureMaximum: 98,
    pinnedReleaseReadsPerClosureMaximum: 98,
    ownerCandidateReads: 2,
  }),
  ordinal: Object.freeze({
    definitionGetters: 11,
    membersSnapshots: 4,
    orderCurrentnessReads: 2,
    sourcePrepare: 1,
    ordinalPrefix: 1,
    rawOrdinalRowsMaximum: 1,
    terminalQueriesBeforeEvaluationMaximum: 1,
    distinctGroupQueries: 1,
    earliestOrdinalProbesMaximum: 99,
    evaluatedSubjectsMaximum: 1,
    closurePasses: 2,
    terminalQueriesPerClosureMaximum: 49,
    factQueriesPerClosureMaximum: 50,
    ownerFactReadsPerClosureMaximum: 98,
    pinnedReleaseReadsPerClosureMaximum: 98,
    ownerCandidateReads: 2,
  }),
  common: Object.freeze({
    initialStepRead: 1,
    releasedOperationalTransaction: 1,
    searchPreparationReleaseReads: 1,
    preparationScopeReads: 2,
    ownerFenceReads: 2,
    sourceTransactionFinish: Object.freeze({ commit: 1, rollback: 1, mutuallyExclusive: true }),
    failureAssociation: 1,
    failureWrite: 1,
    restartDrain: 1,
    restartReset: 1,
    restartRepair: 1,
  }),
});
const sourceStatesPerInvocation = Math.max(
  MEMBERS_PREPARATION_SOURCE_PATHS.id.membersSnapshots,
  MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.membersSnapshots,
);

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
    repeatBound(CANONICAL_SOURCE_RECEIVING_COST().state, sourceStatesPerInvocation),
  );
}
function collectionPrefix() {
  return memoizedValue(collectionPrefix, () =>
    repeatBound(
      sumBounds(
        CANONICAL_SOURCE_RECEIVING_COST().seek,
        CANONICAL_SOURCE_RECEIVING_COST().group(MEMBERS_PREPARATION_SOURCE_PATHS.id.sourceGroupRowsPerQueryMaximum),
      ),
      MEMBERS_PREPARATION_SOURCE_PATHS.id.candidatePrefixMaximum,
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
      paths: MEMBERS_PREPARATION_SOURCE_PATHS,
    }),
  );
}
