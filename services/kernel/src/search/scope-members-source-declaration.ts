import type { WorkDimensions } from '../library/collection-source.ts';
import { MEMBERS_PREPARATION_BRANCH_COST } from '../library/members-preparation-cost.ts';
import { MEMBERS_SEARCH_QUERY_COST } from './scope-members-work-cost.ts';

/** SelectedCost is the eight shared Source dimensions plus engineRequests. Keep the axes named here. */
export const MEMBERS_PREPARATION_SOURCE_AXES = Object.freeze([
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
  'engineRequests',
] as const);

export type MembersPreparationSourceCost = Readonly<Record<(typeof MEMBERS_PREPARATION_SOURCE_AXES)[number], number>>;

export type MembersPreparationSourceTerm = Readonly<{
  name: string;
  multiplicity: number;
  cost: MembersPreparationSourceCost;
}>;

const axes = MEMBERS_PREPARATION_SOURCE_AXES;
const axisSet = new Set<string>(axes);
const knownTermNames = new Set([
  'library-source-metadata-prefix',
  'read-members-snapshot',
  'members-terminal',
  'group',
  'closure',
  'first-members-ordinal',
]);

function isCost(value: unknown): value is MembersPreparationSourceCost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === axes.length &&
    keys.every((key) => axisSet.has(key)) &&
    axes.every((axis) => {
      const amount = (value as Record<string, unknown>)[axis];
      return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0;
    })
  );
}

/** Compose only explicit, finite terms. An allowance, receipt, or omitted axis is never a term. */
export function sumMembersPreparationSourceTerms(
  terms: readonly MembersPreparationSourceTerm[],
): MembersPreparationSourceCost {
  if (!Array.isArray(terms)) throw new TypeError('Invalid Members Source terms');
  const total = Object.fromEntries(axes.map((axis) => [axis, 0])) as Record<(typeof axes)[number], number>;
  for (const term of terms) {
    if (
      !term ||
      typeof term !== 'object' ||
      Object.keys(term).sort().join(',') !== 'cost,multiplicity,name' ||
      typeof term.name !== 'string' ||
      !knownTermNames.has(term.name) ||
      !Number.isSafeInteger(term.multiplicity) ||
      term.multiplicity < 0 ||
      !isCost(term.cost)
    )
      throw new TypeError('Unknown or unbounded Members Source term');
    for (const axis of axes) {
      const value = total[axis] + term.multiplicity * term.cost[axis];
      if (!Number.isSafeInteger(value)) throw new TypeError('Members Source declaration overflow');
      total[axis] = value;
    }
  }
  return Object.freeze(total);
}

function selectedCost(cost: Readonly<WorkDimensions>): MembersPreparationSourceCost {
  return Object.freeze({ ...cost, engineRequests: 0 });
}

function pathMaximum(idCount: number, ordinalCount: number): number {
  return idCount > ordinalCount ? idCount : ordinalCount;
}

const allAxes = axes;

/** Call counts from readReleasedPreparationSource -> advancePreparation -> Search Scope Source.
 * id and ordinal are mutually exclusive. Evaluation handles one subject; it never follows a page. */
export const MEMBERS_PREPARATION_SOURCE_PATHS = Object.freeze({
  id: Object.freeze({
    definitionGetters: 15,
    membersSnapshots: 8,
    orderCurrentnessReads: 4,
    sourcePrepare: 1,
    sourcePrefix: 1,
    evaluatedSubjects: 1,
    candidatePrefixMaximum: 2,
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

/**
 * Library metadata prefix plus Search-owned SQL/parameter terms. Id and ordinal are
 * mutually exclusive; each Search term's multiplicity is the larger path maximum.
 * Facts use limit 50, the remaining that 50 ids leave for those 50 calls.
 * This is still not a complete quote: child owners remain missing.
 */
export const MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS = Object.freeze([
  Object.freeze({
    name: 'library-source-metadata-prefix',
    multiplicity: 1,
    cost: selectedCost(MEMBERS_PREPARATION_BRANCH_COST.sourceMetadata),
  }),
  Object.freeze({
    name: 'read-members-snapshot',
    multiplicity: pathMaximum(
      MEMBERS_PREPARATION_SOURCE_PATHS.id.membersSnapshots,
      MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.membersSnapshots,
    ),
    cost: selectedCost(MEMBERS_SEARCH_QUERY_COST.snapshot),
  }),
  Object.freeze({
    name: 'members-terminal',
    multiplicity: pathMaximum(
      MEMBERS_PREPARATION_SOURCE_PATHS.id.closurePasses *
        MEMBERS_PREPARATION_SOURCE_PATHS.id.terminalQueriesPerClosureMaximum,
      MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.terminalQueriesBeforeEvaluationMaximum +
        MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.closurePasses *
          MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.terminalQueriesPerClosureMaximum,
    ),
    cost: selectedCost(MEMBERS_SEARCH_QUERY_COST.terminal),
  }),
  Object.freeze({
    name: 'group',
    multiplicity: pathMaximum(
      MEMBERS_PREPARATION_SOURCE_PATHS.id.distinctGroupQueries,
      MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.distinctGroupQueries,
    ),
    cost: selectedCost(MEMBERS_SEARCH_QUERY_COST.group),
  }),
  Object.freeze({
    name: 'closure',
    multiplicity: pathMaximum(
      MEMBERS_PREPARATION_SOURCE_PATHS.id.closurePasses *
        MEMBERS_PREPARATION_SOURCE_PATHS.id.factQueriesPerClosureMaximum,
      MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.closurePasses *
        MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.factQueriesPerClosureMaximum,
    ),
    cost: selectedCost(MEMBERS_SEARCH_QUERY_COST.facts),
  }),
  Object.freeze({
    name: 'first-members-ordinal',
    multiplicity: MEMBERS_PREPARATION_SOURCE_PATHS.ordinal.earliestOrdinalProbesMaximum,
    cost: selectedCost(MEMBERS_SEARCH_QUERY_COST.ordinalProbe),
  }),
] satisfies readonly MembersPreparationSourceTerm[]);

/**
 * These dependencies are deliberately unresolved. The known subtotal is useful for
 * composition review, but this export has no `cost` field and cannot populate SelectedChildren.source.
 */
export const MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS = Object.freeze([
  Object.freeze({
    name: 'library-work-definition-source-authority-and-price',
    owner: 'Library',
    body: 'MembersPreparation.readWorkDefinition -> readRetainedDefinition -> restorePreparationDefinition/readRelease',
    callsByPath: Object.freeze({
      id: Object.freeze({ total: 15, metadataPrefixPriced: 3, nestedGetterCalls: 12 }),
      ordinal: Object.freeze({ total: 11, metadataPrefixPriced: 3, nestedGetterCalls: 8 }),
    }),
    axes: allAxes,
    missing: Object.freeze([
      'NativeSourceIdentity from the current native Source row',
      'CollectionSourceObservation from that row and its current basis/revision',
      'finite cost for retained header, immutable release lookup/projection, and each reached native query',
      'same-live-client source fence and post-read currentness comparison',
    ]),
  }),
  Object.freeze({
    name: 'library-collection-source-transitive-price',
    owner: 'Library',
    body: 'readCollectionSourceWorkState and createCollectionSource prepare/prefix/rawOrdinalPrefix',
    callsByPath: Object.freeze({
      id: Object.freeze({ stateReads: 8, prepare: 1, prefix: 1 }),
      ordinal: Object.freeze({ stateReads: 4, prepare: 1, rawOrdinalPrefix: 1 }),
    }),
    axes: allAxes,
    missing: Object.freeze([
      'finite per-call dimensions for every reached native statement',
      'transitive row, point, empty-seek, and byte projections',
      'composition of those prices over the id and ordinal paths',
    ]),
  }),
  Object.freeze({
    name: 'semantic-identity-currentness-price',
    owner: 'Semantic',
    body: 'createIdentityScopedObservations.revalidate from readMembersSnapshot',
    callsByPath: Object.freeze({ id: 8, ordinal: 4 }),
    axes: allAxes,
    missing: Object.freeze([
      'finite child quote for capture/revision revalidation and its transitive native statements',
      'currentness failure and cleanup price',
    ]),
  }),
  Object.freeze({
    name: 'library-owner-filter-evidence-price',
    owner: 'Search and Library',
    body: 'membersTerminal, group, owner fact reads, acceptedRelease, and readOwnerFilterCandidate',
    callsByPath: Object.freeze({
      id: Object.freeze({
        closures: 2,
        terminalQueriesPerClosure: 49,
        factQueriesPerClosure: 50,
        ownerFactReadsPerClosure: 98,
        pinnedReleaseReadsPerClosure: 98,
        ownerCandidateReads: 2,
      }),
      ordinal: Object.freeze({
        rawRows: 1,
        earliestOrdinalProbes: 99,
        closures: 2,
        terminalQueriesPerClosure: 49,
        factQueriesPerClosure: 50,
        ownerFactReadsPerClosure: 98,
        pinnedReleaseReadsPerClosure: 98,
        ownerCandidateReads: 2,
      }),
    }),
    axes: allAxes,
    missing: Object.freeze([
      'finite transitive native statement prices for each owner fact/provider operation',
      'finite byte projections for fact rows and immutable pinned release bodies',
      'the aggregate price across both currentness closures',
    ]),
  }),
  Object.freeze({
    name: 'core-source-transaction-lifecycle-price',
    owner: 'Core',
    body: 'runOperationalTransaction around readReleasedPreparationSource',
    callsByPath: Object.freeze({ success: 1, failedReadRollback: 1 }),
    axes: allAxes,
    missing: Object.freeze([
      'same-client work-step setup, time and owner fences',
      'commit or reached rollback/connection cleanup dimensions',
    ]),
  }),
  Object.freeze({
    name: 'selected-runtime-source-field-and-final-authority',
    owner: 'Commerce successor with Library producer ownership',
    body: 'MEMBERS_SELECTED_CHILDREN.source and checkMembersPreparationCompletion',
    callsByPath: Object.freeze({ sourceRead: 1, selectedFailure: 1, finalPhysicalAuthority: 1 }),
    axes: allAxes,
    missing: Object.freeze([
      'complete SelectedCost for the released Source invocation, including reached rollback',
      'actual SelectedChildren.source binding',
      'final physical source authority; current completion returns selected-runtime-final-source-physical-authority-unavailable',
    ]),
  }),
] as const);

export const MEMBERS_PREPARATION_SOURCE_DECLARATION = Object.freeze({
  status: 'incomplete' as const,
  knownSubtotal: sumMembersPreparationSourceTerms(MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS),
  knownTerms: MEMBERS_PREPARATION_SOURCE_KNOWN_TERMS,
  paths: MEMBERS_PREPARATION_SOURCE_PATHS,
  missing: MEMBERS_PREPARATION_SOURCE_MISSING_DECLARATIONS,
});
