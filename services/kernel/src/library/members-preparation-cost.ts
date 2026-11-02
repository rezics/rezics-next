import type { WorkDimensions } from './collection-source.ts';
import { ProblemError } from '../http/problem.ts';
import { OPERATIONAL_WORK_REGISTRATION, OPERATIONAL_WORK_TRANSFER_COST } from '../history/operational-work.ts';

/** Members-owned SQL ceilings, not funding and not a quote for Core, Access, Search or History.
 * All eight axes are named: History and Source use different tuple orders.
 * SQL text/parameters and bounded projections are included. A failed, empty, duplicate or
 * rolled-back dispatch retains its full ceiling; these declarations grant no refund or replay.
 * Header/binding bytes cover JSON escaping of the 196608-byte canonical basis bound.
 * Reservations examine <=16 definitions and <=32 retirements; work/read/drain pages <=100.
 * Index operations and the result FK are included in nativePoints. New tables have no SQL triggers.
 */
export const MEMBERS_PREPARATION_LOCAL_COST = Object.freeze({
  "ownerLock": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 2,
    "nativePoints": 2,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  "ownerInsert": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 3,
    "nativePoints": 3,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  "liveDefinitions": {
    "candidateKeys": 0,
    "nativeRows": 32,
    "identityMetadataRows": 0,
    "emptySeeks": 32,
    "nativePoints": 32,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 4194304
  },
  "lru": {
    "candidateKeys": 0,
    "nativeRows": 32,
    "identityMetadataRows": 0,
    "emptySeeks": 1,
    "nativePoints": 1,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 4096
  },
  "reservation": {
    "candidateKeys": 0,
    "nativeRows": 50,
    "identityMetadataRows": 0,
    "emptySeeks": 512,
    "nativePoints": 512,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 4194304
  },
  "association": {
    "candidateKeys": 0,
    "nativeRows": 52,
    "identityMetadataRows": 0,
    "emptySeeks": 100,
    "nativePoints": 100,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 4194304
  },
  "step": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 2,
    "nativePoints": 2,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1048576
  },
  "headerRead": {
    "candidateKeys": 0,
    "nativeRows": 1,
    "identityMetadataRows": 0,
    "emptySeeks": 1,
    "nativePoints": 1,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 2097152
  },
  "originalRead": {
    "candidateKeys": 0,
    "nativeRows": 5,
    "identityMetadataRows": 0,
    "emptySeeks": 5,
    "nativePoints": 5,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 2097152
  },
  "resultRead": {
    "candidateKeys": 100,
    "nativeRows": 100,
    "identityMetadataRows": 0,
    "emptySeeks": 1,
    "nativePoints": 1,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 8192
  },
  "touch": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 5,
    "nativePoints": 5,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  // Four retained result indexes, duplicate probes and parent FK checks for at most 100 candidates.
  "apply": {
    "candidateKeys": 100,
    "nativeRows": 256,
    "identityMetadataRows": 0,
    "emptySeeks": 768,
    "nativePoints": 768,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 65536
  },
  "reset": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 2,
    "nativePoints": 2,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  "failure": {
    "candidateKeys": 0,
    "nativeRows": 1,
    "identityMetadataRows": 0,
    "emptySeeks": 1,
    "nativePoints": 1,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  "retire": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 6,
    "nativePoints": 6,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  // At most 100 key reads and deletes; primary lookups plus all four retained result indexes.
  // The finite ceiling also covers the prefix seek and empty/failed dispatches.
  "resultDrain": {
    "candidateKeys": 100,
    "nativeRows": 201,
    "identityMetadataRows": 0,
    "emptySeeks": 512,
    "nativePoints": 512,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 16384
  },
  "headerDrain": {
    "candidateKeys": 0,
    "nativeRows": 2,
    "identityMetadataRows": 0,
    "emptySeeks": 6,
    "nativePoints": 6,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 1024
  },
  "idlePage": {
    "candidateKeys": 0,
    "nativeRows": 16,
    "identityMetadataRows": 0,
    "emptySeeks": 2,
    "nativePoints": 2,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 4096
  },
  "readControl": {
    "candidateKeys": 0,
    "nativeRows": 0,
    "identityMetadataRows": 0,
    "emptySeeks": 0,
    "nativePoints": 0,
    "witnessKeys": 0,
    "statements": 5,
    "bytes": 1024
  },
  "rollbackControl": {
    "candidateKeys": 0,
    "nativeRows": 0,
    "identityMetadataRows": 0,
    "emptySeeks": 0,
    "nativePoints": 0,
    "witnessKeys": 0,
    "statements": 1,
    "bytes": 256
  },
  // Exact Source metadata: Collection, partition, head, complete generation and Scope point.
  sourceMetadata: { candidateKeys: 0, nativeRows: 5, identityMetadataRows: 0, emptySeeks: 5,
    nativePoints: 5, witnessKeys: 0, statements: 1, bytes: 2097152 },
  ownerFence: { candidateKeys: 0, nativeRows: 1, identityMetadataRows: 0, emptySeeks: 1,
    nativePoints: 1, witnessKeys: 0, statements: 1, bytes: 1024 },
  // Header/selection points plus the header UPDATE/index maintenance. Selection JSON comparison
  // includes its bounded 2 MiB tuple projection, deserialization and exact-basis comparison.
  selectedAssociation: { candidateKeys: 0, nativeRows: 3, identityMetadataRows: 0, emptySeeks: 4,
    nativePoints: 4, witnessKeys: 0, statements: 1, bytes: 6291456 },
  completionRead: { candidateKeys: 0, nativeRows: 3, identityMetadataRows: 0, emptySeeks: 3,
    nativePoints: 3, witnessKeys: 0, statements: 1, bytes: 6291456 },
  repair: { candidateKeys: 0, nativeRows: 2, identityMetadataRows: 0, emptySeeks: 2,
    nativePoints: 2, witnessKeys: 0, statements: 1, bytes: 1024 },
} satisfies Record<string, Readonly<WorkDimensions>>);

/** Members-owned body allowance, with the stronger Members raw-key bound; not the whole C3 parent. Never use compatibility
 * scopeAllowance defaults (8192 statements), renew this body on refill, or fund a parent with child prices.
 * Native/identity rows share the single examined-row ceiling; Source may refuse its smaller transfer.
 */
export const MEMBERS_PREPARATION_STEP_CEILING: Readonly<WorkDimensions> = Object.freeze({
  candidateKeys: 100,
  nativeRows: 1600,
  identityMetadataRows: 64,
  emptySeeks: 800,
  nativePoints: 800,
  witnessKeys: 100,
  statements: 16,
  bytes: 4194304,
});

/** Local prices above cannot close these foreign branches or establish a whole-parent quote.
 * Operational History supplies its actual named registration/transfer/receiving prices itself.
 * Source currentness, SDK restoration/retirement and physical closure are independent operands.
 */
export const MEMBERS_PREPARATION_FOREIGN_OPERANDS = Object.freeze([
  'selected-runtime-source-declaration-unavailable',
  'selected-runtime-final-source-physical-authority-unavailable',
  'whole-members-source-library-cost-unavailable',
  'operational-work-source-currentness-unavailable',
  'sdk-restore-retirement-unavailable',
  'independent-physical-closure-unavailable',
] as const);

const axes = ['candidateKeys', 'nativeRows', 'identityMetadataRows', 'emptySeeks',
  'nativePoints', 'witnessKeys', 'statements', 'bytes'] as const;
/** Composition never depends on producer tuple order. A price is not a new allocation. */
export function membersPreparationCost(...parts: readonly Readonly<WorkDimensions>[]): WorkDimensions {
  const total: { -readonly [Axis in keyof WorkDimensions]: WorkDimensions[Axis] } = { candidateKeys: 0, nativeRows: 0, identityMetadataRows: 0,
    emptySeeks: 0, nativePoints: 0, witnessKeys: 0, statements: 0, bytes: 0 };
  for (const part of parts) for (const axis of axes) total[axis] += part[axis];
  return total;
}

/** Branches use the same absolute horizon. Each attempted prefix stays charged on failure/rollback;
 * an empty point/duplicate pays its full statement/index ceiling, not a guessed zero-row price.
 * Body repeats add these prices again; Core/Access envelope and foreign Source prices are additional.
 * Branch components compose by name: apply plus completion or repair, then a reached failure if needed.
 * Early exits pay their dispatched prefix; unused phases are never charged as dispatched or refunded.
 */
export const MEMBERS_PREPARATION_BRANCH_COST = Object.freeze({
  duplicate: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.ownerLock,
    MEMBERS_PREPARATION_LOCAL_COST.liveDefinitions),
  newReservation: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.ownerLock,
    MEMBERS_PREPARATION_LOCAL_COST.ownerInsert, MEMBERS_PREPARATION_LOCAL_COST.ownerLock,
    MEMBERS_PREPARATION_LOCAL_COST.liveDefinitions, MEMBERS_PREPARATION_LOCAL_COST.lru,
    MEMBERS_PREPARATION_LOCAL_COST.reservation, MEMBERS_PREPARATION_LOCAL_COST.association),
  successfulRead: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.readControl,
    MEMBERS_PREPARATION_LOCAL_COST.headerRead, MEMBERS_PREPARATION_LOCAL_COST.originalRead,
    MEMBERS_PREPARATION_LOCAL_COST.completionRead,
    MEMBERS_PREPARATION_LOCAL_COST.resultRead, MEMBERS_PREPARATION_LOCAL_COST.ownerLock,
    MEMBERS_PREPARATION_LOCAL_COST.touch),
  incompleteRead: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.readControl,
    MEMBERS_PREPARATION_LOCAL_COST.headerRead),
  // Released Source's OWN metadata prefix: three definition getters (two step reads each),
  // initial state, two Scope reads and two owner fences. Releases/Search/native Source remain foreign.
  sourceMetadata: membersPreparationCost(
    ...Array.from({ length: 9 }, () => MEMBERS_PREPARATION_LOCAL_COST.step),
    ...Array.from({ length: 5 }, () => MEMBERS_PREPARATION_LOCAL_COST.sourceMetadata),
    MEMBERS_PREPARATION_LOCAL_COST.ownerFence, MEMBERS_PREPARATION_LOCAL_COST.ownerFence),
  advance: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.step,
    MEMBERS_PREPARATION_LOCAL_COST.selectedAssociation, MEMBERS_PREPARATION_LOCAL_COST.step,
    MEMBERS_PREPARATION_LOCAL_COST.sourceMetadata, MEMBERS_PREPARATION_LOCAL_COST.ownerFence,
    MEMBERS_PREPARATION_LOCAL_COST.apply),
  completion: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.step,
    MEMBERS_PREPARATION_LOCAL_COST.originalRead),
  restart: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.resultDrain,
    MEMBERS_PREPARATION_LOCAL_COST.reset, MEMBERS_PREPARATION_LOCAL_COST.repair),
  failure: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.step,
    MEMBERS_PREPARATION_LOCAL_COST.selectedAssociation, MEMBERS_PREPARATION_LOCAL_COST.failure),
  cleanup: membersPreparationCost(MEMBERS_PREPARATION_LOCAL_COST.ownerLock,
    MEMBERS_PREPARATION_LOCAL_COST.retire, MEMBERS_PREPARATION_LOCAL_COST.resultDrain,
    MEMBERS_PREPARATION_LOCAL_COST.headerDrain),
  idle: MEMBERS_PREPARATION_LOCAL_COST.idlePage,
});

/** C3 fixes the body allowance independently of constant History costs. This subset
 * is still not a funded parent: Core/Access, retries, executor and cleanup must all
 * be declared and prepaid before first I/O. Never allocate from this subtotal.
 */
export const MEMBERS_PREPARATION_RESERVATION_SUBTOTAL = Object.freeze(membersPreparationCost(
  MEMBERS_PREPARATION_BRANCH_COST.newReservation,
  OPERATIONAL_WORK_REGISTRATION, OPERATIONAL_WORK_TRANSFER_COST.resolve,
  OPERATIONAL_WORK_TRANSFER_COST.verify, OPERATIONAL_WORK_TRANSFER_COST.receive,
));

export function requireMembersReservationBudget(): void {
  throw new ProblemError('dependency_unavailable', {
    detail: 'whole-members-reservation-cost-unavailable: finite C3 parent including Core/Access, executor controls, retries and cleanup is not declared',
  });
}
