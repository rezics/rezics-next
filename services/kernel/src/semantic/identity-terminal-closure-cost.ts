import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';

export const IDENTITY_TERMINAL_AXES = Object.freeze([
  'candidateKeys', 'nativeRows', 'identityMetadataRows', 'nativePoints',
  'witnessKeys', 'statements', 'bytes', 'emptySeeks',
] as const);

/** Same units as Core: binds/projected values, excluding fixed SQL framing.
 * Rows include bounded index/heap/FK/hook work, not just RETURNING rows.
 */
function literal(c: number, r: number, m: number, p: number, w: number, s: number, b: number, e: number): WorkDimensions {
  return Object.freeze({ candidateKeys: c, nativeRows: r, identityMetadataRows: m,
    nativePoints: p, witnessKeys: w, statements: s, bytes: b, emptySeeks: e });
}

export function addIdentityTerminalCosts(...parts: readonly WorkDimensions[]): WorkDimensions {
  const result = { candidateKeys: 0, nativeRows: 0, identityMetadataRows: 0, nativePoints: 0,
    witnessKeys: 0, statements: 0, bytes: 0, emptySeeks: 0 };
  for (const part of parts) for (const axis of IDENTITY_TERMINAL_AXES) {
    const value = part[axis];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result[axis] + value))
      throw new RangeError(`Invalid terminal cost ${axis}`);
    result[axis] += value;
  }
  return Object.freeze(result);
}

/** Fixed metadata transaction used only by the native original arbiter.
 * No Core domain command, authorization, callback, outbox or receipt is run here.
 * Metadata SQL is in identity-terminal-closure-original.ts. All empty probes are
 * charged on successful as well as failed branches. ROLLBACK is disjoint.
 */
export const IDENTITY_TERMINAL_ORIGINAL_COSTS = Object.freeze({
  begin: literal(0, 0, 0, 0, 0, 1, 0, 0),
  lockTimeout: literal(0, 0, 0, 0, 0, 1, 0, 0),
  statementTimeout: literal(0, 0, 0, 0, 0, 1, 12, 0),
  // One owner PK/index + heap + row lock; only int4/int8 projections.
  owner: literal(0, 3, 1, 1, 1, 1, 76, 1),
  // Native receipt PK and page PK, two heaps and two SHARE locks, fixed phase.
  export: literal(0, 6, 2, 2, 1, 1, 186, 2),
  // Source-role and basis absence. Each indexed EXISTS stops at its first row.
  provenanceAbsence: literal(0, 4, 2, 2, 0, 1, 52, 2),
  copyRoleAbsence: literal(0, 3, 1, 1, 0, 1, 80, 1),
  // Original PK seek/heap/lock; full fixed-width vector/header result <=1024.
  original: literal(0, 3, 1, 1, 1, 1, 1104, 1),
  // Coalescing scan visits at most four slot index+heap pairs and one lock.
  sharedSlot: literal(0, 9, 4, 4, 0, 1, 128, 4),
  existingSlot: literal(0, 3, 1, 1, 0, 1, 116, 1),
  // Four candidate slots, at most four PK absence seeks; generation unique and
  // erasure-key unique indexes, sequence and the deferred nonpersonal hook.
  insertSlot: literal(0, 25, 9, 11, 0, 6, 160, 8),
  // Heap + three indexes/lock; hook: owner point, empty copy/source roles/basis.
  allocateCopies: literal(0, 15, 8, 8, 0, 6, 144, 4),
  // INSERT header: heap + PK + proof-unique + reservation index; one ledger FK.
  insertOriginal: literal(0, 8, 3, 4, 1, 2, 1024, 1),
  // One bounded ticket: heap, PK, original FK and reservation FK.
  insertTicket: literal(0, 8, 3, 4, 1, 3, 512, 2),
  // Monotonic ordinal/spent vector UPDATE, PK/heap/lock and RETURNING ordinal.
  debitOriginal: literal(0, 4, 1, 1, 1, 1, 512, 1),
  // The real bootstrap transaction is used only for its empty provenance hook.
  provenanceBinding: literal(0, 1, 0, 0, 0, 1, 72, 0),
  commit: literal(0, 0, 0, 0, 0, 1, 0, 0),
  rollback: literal(0, 0, 0, 0, 0, 1, 0, 0),
  // Native empty-page + advancing-home retirement proof, never a callback result.
  retirement: literal(0, 6, 2, 2, 1, 1, 148, 2),
  deleteTickets: literal(0, 12, 4, 3, 0, 1, 512, 2),
  deleteOriginal: literal(0, 9, 3, 3, 0, 2, 80, 2),
  // Same ledger decrement; physical retirement needs all indexed empty ranges.
  releaseCopies: literal(0, 15, 8, 8, 0, 6, 144, 4),
  // Bucket index/heap/lock + three maintained indexes, seven indexed empty
  // reference probes and two FK empty probes: 15 row/index/lock touches,
  // ten metadata points/seeks, DELETE plus two FK statements, 3 * (int4+uuid).
  // No DELETE erasure trigger exists on this table. INSERT/UPDATE hooks above
  // were reserved separately and run before COMMIT on their captured NEW rows.
  emptySlot: literal(0, 15, 10, 10, 0, 3, 120, 10),
  // SELECT epoch,position WHERE home=$1 AND epoch=$2 AND active, FOR SHARE.
  // Actual effect-home permission JOIN: owner/original/ticket PKs and locks,
  // exact immutable deadline, phase/cursor/price and ordinal=1. Retirement
  // revokes this grant. UUID/int4/int8 and eight bounded decimal price fields.
  ownerRead: literal(0, 9, 3, 3, 3, 1, 272, 3),
});

const c = IDENTITY_TERMINAL_ORIGINAL_COSTS;
const controls = addIdentityTerminalCosts(c.begin, c.lockTimeout, c.statementTimeout, c.commit, c.rollback);
const validation = addIdentityTerminalCosts(c.owner, c.export, c.provenanceAbsence, c.original);
const physical = addIdentityTerminalCosts(c.provenanceBinding, c.sharedSlot, c.copyRoleAbsence, c.existingSlot, c.insertSlot, c.allocateCopies);

/** Includes admission, one irreversible debit, the real Core allowance, body,
 * and one native retirement. Replays have no extra allowance: a replay is an
 * admission attempt by its own producer, not a child effect of the old original.
 */
const ticketValidation = addIdentityTerminalCosts(c.owner, c.original);
const retirementDebit = addIdentityTerminalCosts(controls, ticketValidation, c.insertTicket, c.debitOriginal);
const retirementEffect = addIdentityTerminalCosts(controls, validation, c.retirement, c.deleteTickets,
  c.deleteOriginal, c.provenanceBinding, c.releaseCopies, c.emptySlot);
export const IDENTITY_TERMINAL_OWNER_READ_PLAN = Object.freeze({
  version: 1,
  kind: 'bootstrap-owner-read' as const,
  admission: addIdentityTerminalCosts(controls, validation, physical, c.insertOriginal),
  debit: addIdentityTerminalCosts(controls, ticketValidation, c.insertTicket, c.debitOriginal),
  effect: addIdentityTerminalCosts(COMMAND_DISPATCH_ALLOWANCE.total.work, c.ownerRead),
  retirementDebit,
  retirementEffect,
});
export const IDENTITY_TERMINAL_OWNER_READ_TOTAL = addIdentityTerminalCosts(
  IDENTITY_TERMINAL_OWNER_READ_PLAN.admission, IDENTITY_TERMINAL_OWNER_READ_PLAN.debit,
  IDENTITY_TERMINAL_OWNER_READ_PLAN.effect, retirementDebit, retirementEffect,
);

export type IdentityTerminalMissingOperand = Readonly<{
  owner: 'Core';
  callable: 'withCommandDispatchLifetime';
  profile: 'mutation-events-native-callbacks' | 'principal-authorization-receipt' | 'associated-no-effect';
  producer: string;
}>;

/** A missing operand is not a zero work vector and cannot be dispatched. */
export class IdentityTerminalCompositionError extends IdentityEpochStoreError {
  constructor(readonly operand: IdentityTerminalMissingOperand) {
    super('identity_epoch_unavailable', `${operand.owner}.${operand.callable}: missing ${operand.profile} profile for ${operand.producer}`);
  }
}

export function requireIdentityTerminalExecutor(
  producer: string,
  profile: IdentityTerminalMissingOperand['profile'],
): void {
  throw new IdentityTerminalCompositionError(Object.freeze({ owner: 'Core', callable: 'withCommandDispatchLifetime', profile, producer }));
}
