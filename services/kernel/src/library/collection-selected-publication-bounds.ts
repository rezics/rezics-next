/** Static bounds for the retained finite selected-set publication command. */
import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { COLLECTION_SOURCE_NATIVE_SAVED_PROBE_COST } from './collection-source-native.ts';
import { CANONICAL_SOURCE_RECEIVING_COST } from './canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
import {
  OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT,
  OWNER_FILTER_CLOSURE_REFERENCE_LIMIT,
} from './owner-filter-native-closure.ts';
import { MEMBERS_PREPARATION_SOURCE_COST } from '../search/scope-members-source-declaration.ts';
import { WORK_EXECUTION_ATTEMPT_BOUND } from '../work/selected-runtime-cost.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';

export const COLLECTION_SELECTED_PUBLICATION_LIMIT = 100;
export const COLLECTION_SELECTED_PUBLICATION_ATTEMPTS = WORK_EXECUTION_ATTEMPT_BOUND;

const cost = (values: Omit<Bound, 'engineRequests'>): Bound => declareBound({ ...values, engineRequests: 0 });
const zeroCost = cost({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
});
const engineCost = (engineRequests: number): Bound => declareBound({ ...zeroCost, engineRequests });

function maximumBounds(...values: readonly Bound[]): Bound {
  const axes = Object.keys(values[0]!) as (keyof Bound)[];
  return declareBound(Object.fromEntries(axes.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])));
}

/** Existing native resolveSubject ceiling, paid for every selected ID and each complete closure original. */
export const COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST = cost({
  candidateKeys: 1,
  nativeRows: 8192,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 128,
  witnessKeys: 0,
  statements: 128,
  bytes: 1024 * 1024,
});

const scopeCurrentness = cost({
  candidateKeys: 0,
  nativeRows: 32,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 2,
  witnessKeys: 0,
  statements: 6,
  bytes: 16 * 1024,
});
const commandAdmission = cost({
  candidateKeys: 0,
  nativeRows: 8,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 2,
  witnessKeys: 0,
  statements: 2,
  bytes: 2048,
});
const privateAuthority = cost({
  candidateKeys: 0,
  nativeRows: 8192,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 128,
  witnessKeys: 0,
  statements: 128,
  bytes: 1024 * 1024,
});
const compareHeaderRule = cost({
  candidateKeys: 0,
  nativeRows: 64,
  identityMetadataRows: 0,
  emptySeeks: 2,
  nativePoints: 8,
  witnessKeys: 0,
  statements: 2,
  bytes: 65536,
});

const sourcePrepare = CANONICAL_SOURCE_RECEIVING_COST.state;
const sourceMembership = sumBounds(
  repeatBound(sourcePrepare, 2),
  CANONICAL_SOURCE_RECEIVING_COST.group(COLLECTION_SOURCE_WORK_GROUP_LIMIT),
  repeatBound(COLLECTION_SOURCE_NATIVE_SAVED_PROBE_COST, COLLECTION_SOURCE_WORK_GROUP_LIMIT),
);
const closureAndOwnerFacts = sumBounds(
  MEMBERS_PREPARATION_SOURCE_COST,
  CANONICAL_SOURCE_RECEIVING_COST.group(OWNER_FILTER_CLOSURE_REFERENCE_LIMIT),
);
const ownerFilterMatch = MEMBERS_PREPARATION_SOURCE_COST;
function canonicalDeduplicationFor(selectionCount: number) {
  return cost({
    candidateKeys: selectionCount,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: Math.ceil((16 * 1024 * selectionCount) / COLLECTION_SELECTED_PUBLICATION_LIMIT),
  });
}
const positiveMembership = sumBounds(
  sourceMembership,
  repeatBound(COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT),
  closureAndOwnerFacts,
  ownerFilterMatch,
);
const negativeMembership = sourceMembership;
const selectedBranch = sumBounds(
  COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST,
  maximumBounds(positiveMembership, negativeMembership),
);

const nativeOutputMetadata = cost({
  candidateKeys: 0,
  nativeRows: 2048,
  identityMetadataRows: 0,
  emptySeeks: 32,
  nativePoints: 128,
  witnessKeys: 0,
  statements: 64,
  bytes: 65536,
});
function nativeOutputRows(selectionCount: number) {
  return cost({
    candidateKeys: selectionCount,
    nativeRows: 32 * selectionCount,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 8 * selectionCount,
    witnessKeys: 0,
    statements: 0,
    bytes: 512 * selectionCount,
  });
}
const outputActivation = cost({
  candidateKeys: 0,
  nativeRows: 256,
  identityMetadataRows: 0,
  emptySeeks: 8,
  nativePoints: 32,
  witnessKeys: 0,
  statements: 32,
  bytes: 32768,
});
const metadataHistory = cost({
  candidateKeys: 0,
  nativeRows: 128,
  identityMetadataRows: 0,
  emptySeeks: 4,
  nativePoints: 32,
  witnessKeys: 0,
  statements: 24,
  bytes: 32768,
});
const historyEventCommit = cost({
  candidateKeys: 0,
  nativeRows: 128,
  identityMetadataRows: 0,
  emptySeeks: 8,
  nativePoints: 32,
  witnessKeys: 0,
  statements: 32,
  bytes: 65536,
});
const receiptLookup = cost({
  candidateKeys: 0,
  nativeRows: 16,
  identityMetadataRows: 0,
  emptySeeks: 1,
  nativePoints: 2,
  witnessKeys: 0,
  statements: 2,
  bytes: 8192,
});
const receiptWrite = cost({
  candidateKeys: 0,
  nativeRows: 32,
  identityMetadataRows: 0,
  emptySeeks: 2,
  nativePoints: 8,
  witnessKeys: 0,
  statements: 8,
  bytes: 16384,
});
const serialization = cost({
  candidateKeys: 0,
  nativeRows: 32,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 65536,
});
const events = cost({
  candidateKeys: 0,
  nativeRows: 32,
  identityMetadataRows: 0,
  emptySeeks: 2,
  nativePoints: 8,
  witnessKeys: 0,
  statements: 8,
  bytes: 16384,
});
const rollback = cost({
  candidateKeys: 0,
  nativeRows: 64,
  identityMetadataRows: 0,
  emptySeeks: 4,
  nativePoints: 16,
  witnessKeys: 0,
  statements: 16,
  bytes: 32768,
});

const binder = sumBounds(
  sourcePrepare,
  privateAuthority,
  MEMBERS_PREPARATION_SOURCE_COST,
  scopeCurrentness,
  commandAdmission,
);
const preparationFixed = sumBounds(
  repeatBound(sourcePrepare, 2),
  repeatBound(scopeCurrentness, 2),
  MEMBERS_PREPARATION_SOURCE_COST,
  privateAuthority,
);
const preReceipt = sumBounds(compareHeaderRule, privateAuthority, sourcePrepare, scopeCurrentness, commandAdmission);
function nativeTransactionFor(selectionCount: number) {
  return sumBounds(
    nativeOutputMetadata,
    nativeOutputRows(selectionCount),
    outputActivation,
    metadataHistory,
    historyEventCommit,
    receiptLookup,
    receiptWrite,
    serialization,
    events,
    rollback,
  );
}

export type CollectionSelectedPublicationPlan = Readonly<{
  selectionCount: number;
  terms: Readonly<{
    binding: Bound;
    selectedBranches: Bound;
    selectedBranch: Bound;
    positiveMembership: Bound;
    negativeMembership: Bound;
    sourceMembership: Bound;
    closureAndOwnerFacts: Bound;
    ownerFilterMatch: Bound;
    searchScopePreparationWork: Bound;
    searchScopeSelectionEvaluationWork: Bound;
    searchScopeFinalEvaluationWork: Bound;
    searchScopeEngineRequests: Bound;
    scopeCurrentness: Bound;
    sourcePreparation: Bound;
    canonicalDeduplication: Bound;
    ownerFilterReauthorization: Bound;
    preparation: Bound;
    preReceipt: Bound;
    compareHeaderRule: Bound;
    privateAuthority: Bound;
    nativeTransaction: Bound;
    outputReservation: Bound;
    receiptLookup: Bound;
    receiptWrite: Bound;
    serialization: Bound;
    rollback: Bound;
    retries: Bound;
  }>;
  nativePerAttempt: Bound;
  perAttempt: Bound;
  ceiling: Bound;
  bindingWork: WorkDimensions;
}>;

/** The complete original closure is bounded separately from the raw selection branch count. */
export function collectionSelectedPublicationPlan(
  selectionCount: number,
  source: 'owner' | 'catalogue' = 'owner',
): CollectionSelectedPublicationPlan {
  if (
    !Number.isSafeInteger(selectionCount) ||
    selectionCount < 0 ||
    selectionCount > COLLECTION_SELECTED_PUBLICATION_LIMIT
  )
    throw new RangeError('Invalid selected publication count');
  const catalogue = source === 'catalogue';
  // Search scope preparation makes two initial index requests and rechecks the index twice;
  // each read-only evaluation performs one index-currentness request. Catalogue evidence is native SQL.
  const searchScopePreparationWork = catalogue && selectionCount > 0 ? MEMBERS_PREPARATION_SOURCE_COST : zeroCost;
  const searchScopeSelectionEvaluationWork = catalogue && selectionCount > 0 ? MEMBERS_PREPARATION_SOURCE_COST : zeroCost;
  const searchScopeFinalEvaluationWork = catalogue && selectionCount > 0 ? MEMBERS_PREPARATION_SOURCE_COST : zeroCost;
  const searchScopeEngineRequests = catalogue
    ? sumBounds(
        engineCost(selectionCount > 0 ? 4 : 0),
        engineCost(selectionCount),
        engineCost(selectionCount > 0 ? 1 : 0),
      )
    : zeroCost;
  const maxSearchScopeEngineRequests = catalogue
    ? sumBounds(engineCost(4), engineCost(COLLECTION_SELECTED_PUBLICATION_LIMIT), engineCost(1))
    : zeroCost;
  const plannedSourceMembership = catalogue ? zeroCost : sourceMembership;
  const plannedPositiveMembership = catalogue
    ? sumBounds(
        repeatBound(COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT),
        closureAndOwnerFacts,
        searchScopeSelectionEvaluationWork,
      )
    : positiveMembership;
  const plannedNegativeMembership = catalogue ? searchScopeSelectionEvaluationWork : negativeMembership;
  const maxCataloguePositiveMembership = catalogue
    ? sumBounds(
        repeatBound(COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST, OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT),
        closureAndOwnerFacts,
        MEMBERS_PREPARATION_SOURCE_COST,
      )
    : positiveMembership;
  const maxCatalogueNegativeMembership = catalogue ? MEMBERS_PREPARATION_SOURCE_COST : negativeMembership;
  const maxSelectedBranch = catalogue
    ? sumBounds(
        COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST,
        maximumBounds(maxCataloguePositiveMembership, maxCatalogueNegativeMembership),
      )
    : selectedBranch;
  const plannedPreparationFixed =
    catalogue && selectionCount > 0
      ? sumBounds(preparationFixed, searchScopePreparationWork, searchScopeFinalEvaluationWork)
      : preparationFixed;
  const plannedOwnerFilterMatch = catalogue ? zeroCost : ownerFilterMatch;
  const plannedOwnerFilterReauthorization = sumBounds(
    MEMBERS_PREPARATION_SOURCE_COST,
    privateAuthority,
    searchScopeFinalEvaluationWork,
  );
  const plannedSelectedBranch = sumBounds(
    COLLECTION_SELECTED_PUBLICATION_DISCLOSURE_COST,
    maximumBounds(plannedPositiveMembership, plannedNegativeMembership),
  );
  const branches = repeatBound(plannedSelectedBranch, selectionCount);
  const canonicalDeduplication = canonicalDeduplicationFor(selectionCount);
  const preparation = sumBounds(plannedPreparationFixed, canonicalDeduplication, branches);
  const nativeTransaction = nativeTransactionFor(selectionCount);
  const nativePerAttempt = sumBounds(binder, preparation, preReceipt, nativeTransaction);
  const perAttempt = sumBounds(nativePerAttempt, searchScopeEngineRequests);
  const maxAttempt = sumBounds(
    binder,
    plannedPreparationFixed,
    canonicalDeduplicationFor(COLLECTION_SELECTED_PUBLICATION_LIMIT),
    repeatBound(maxSelectedBranch, COLLECTION_SELECTED_PUBLICATION_LIMIT),
    preReceipt,
    nativeTransactionFor(COLLECTION_SELECTED_PUBLICATION_LIMIT),
    maxSearchScopeEngineRequests,
  );
  const ceiling = repeatBound(maxAttempt, COLLECTION_SELECTED_PUBLICATION_ATTEMPTS);
  if (!withinCeiling(perAttempt, ceiling)) throw new TypeError('Selected publication exceeds its native ceiling');
  return Object.freeze({
    selectionCount,
    terms: Object.freeze({
      binding: binder,
      selectedBranches: branches,
      selectedBranch: plannedSelectedBranch,
      positiveMembership: plannedPositiveMembership,
      negativeMembership: plannedNegativeMembership,
      sourceMembership: plannedSourceMembership,
      closureAndOwnerFacts,
      ownerFilterMatch: plannedOwnerFilterMatch,
      searchScopePreparationWork,
      searchScopeSelectionEvaluationWork,
      searchScopeFinalEvaluationWork,
      searchScopeEngineRequests,
      scopeCurrentness,
      sourcePreparation: sourcePrepare,
      canonicalDeduplication,
      ownerFilterReauthorization: plannedOwnerFilterReauthorization,
      preparation,
      preReceipt,
      compareHeaderRule,
      privateAuthority,
      nativeTransaction,
      outputReservation: nativeTransaction,
      receiptLookup,
      receiptWrite,
      serialization,
      rollback,
      retries: ceiling,
    }),
    nativePerAttempt,
    perAttempt,
    ceiling,
    bindingWork: nativeWorkDimensions(binder),
  });
}

/** Named 9-axis to legacy native 8-axis translation; engine work cannot disappear at this boundary. */
export function nativeWorkDimensions(value: Bound): WorkDimensions {
  const bound = declareBound(value);
  if (bound.engineRequests !== 0) throw new RangeError('Native Collection work cannot fund engine requests');
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    identityMetadataRows: bound.identityMetadataRows,
    nativeRows: bound.nativeRows,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
    emptySeeks: bound.emptySeeks,
  });
}

export function nativeWorkAllowance(value: Bound, reservationId: string): WorkAllowance {
  if (!reservationId) throw new TypeError('Missing native work reservation');
  return Object.freeze({ reservationId, remaining: nativeWorkDimensions(value) });
}

/** Older native receipts are translated back with an explicit zero engine dimension. */
export function nativeReceiptBound(receipt: WorkReceipt): Bound {
  return declareBound({ ...receipt.used, engineRequests: 0 });
}

export function collectionSelectedPublicationOutputReservation(selectionCount: number): Bound {
  if (
    !Number.isSafeInteger(selectionCount) ||
    selectionCount < 0 ||
    selectionCount > COLLECTION_SELECTED_PUBLICATION_LIMIT
  )
    throw new RangeError('Invalid selected publication count');
  return nativeTransactionFor(selectionCount);
}
export const COLLECTION_SELECTED_PUBLICATION_SOURCE_PREPARATION = sourcePrepare;
export const COLLECTION_SELECTED_PUBLICATION_SOURCE_MEMBERSHIP = sourceMembership;
