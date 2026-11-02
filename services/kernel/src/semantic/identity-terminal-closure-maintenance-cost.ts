import { addIdentityTerminalCosts, IDENTITY_TERMINAL_ORIGINAL_COSTS as c } from './identity-terminal-closure-cost.ts';
import type { WorkDimensions } from '../library/collection-source.ts';

const literal = (r: number, m: number, p: number, w: number, s: number, b: number, e: number): WorkDimensions =>
  Object.freeze({ candidateKeys: 0, nativeRows: r, identityMetadataRows: m, nativePoints: p,
    witnessKeys: w, statements: s, bytes: b, emptySeeks: e });

/** Bounded metadata-only bodies in identity-terminal-closure-maintenance.ts.
 * No Core event/callback allowance is included or borrowed from noEffect.
 * Bytes count bindings and projected values, with fixed SQL framing excluded.
 * The predecessor PK/unique index fixes cardinality at ONE, tickets at TWO;
 * none of these bounds comes from a population scan or a postdispatch counter.
 */
export const IDENTITY_TERMINAL_MAINTENANCE_COSTS = Object.freeze({
  // Page PK, root source PK, BOTH native receipt PKs, home PK and export prefix:
  // five locked heaps/indexes + one empty seek. Fixed receipt/header <=1920 B.
  currentGrant: literal(16, 6, 6, 5, 1, 2176, 6),
  // Root PK/heap/lock, including its immutable vector/header and cleanup pointer.
  root: literal(3, 1, 1, 1, 1, 1216, 1),
  // At most ONE predecessor unique entry, heap and row lock, same full header.
  predecessor: literal(3, 1, 1, 1, 1, 1216, 1),
  // Two ticket PK entries/heaps/locks; explicit fixed projections (not SELECT *).
  tickets: literal(6, 2, 2, 2, 1, 1216, 2),
  // Ledger PK/heap/lock and one indexed personal-copy-role exclusion.
  reservation: literal(5, 2, 2, 1, 1, 200, 2),
  deleteTickets: c.deleteTickets,
  // Maintenance heap, PK, source unique, reservation and predecessor indexes;
  // ticket-FK indexed empty proof. Root deletion is charged separately.
  deleteMaintenance: literal(10, 4, 4, 0, 2, 80, 2),
  insertMaintenance: literal(9, 4, 5, 1, 2, 1216, 1),
  // Root ordinal=2 is revocation only: its spent vector NEVER decreases or
  // resets. Header guard performs no SQL and introduces no free dependency IO.
  transfer: literal(4, 1, 1, 1, 1, 96, 1),
  // Page PK/heap/lock, exact latest native grant predicate, RETURNING receipt.
  complete: literal(4, 1, 1, 1, 1, 128, 1),
  // Native producer callback only: page/owner/root/current-maintenance PKs,
  // current ticket keyset and row locks, then same-page UPDATE. The Core
  // callback/event executor is an explicit missing operand, NEVER priced zero.
  recordGrant: literal(30, 10, 10, 7, 3, 2048, 10),
  // recordIdentityEpochNativeCommit: actual INSERT..SELECT owner FOR UPDATE,
  // native heap/PK, owner PK/heap/lock and the bounded RETURNING transaction ID.
  nativeCommit: literal(7, 2, 3, 1, 1, 128, 1),
});
const m = IDENTITY_TERMINAL_MAINTENANCE_COSTS;
const controls = addIdentityTerminalCosts(c.begin, c.lockTimeout, c.statementTimeout, c.owner, c.commit, c.rollback);
const validation = addIdentityTerminalCosts(m.currentGrant, c.provenanceAbsence, m.root, m.predecessor, m.reservation);
export const IDENTITY_TERMINAL_MAINTENANCE_GRANT_BODY = addIdentityTerminalCosts(m.recordGrant, m.nativeCommit);
export const IDENTITY_TERMINAL_MAINTENANCE_PLAN = Object.freeze({
  version: 1,
  kind: 'bootstrap-original-maintenance' as const,
  admission: addIdentityTerminalCosts(controls, validation, m.tickets, m.deleteTickets,
    m.deleteMaintenance, m.insertMaintenance, m.transfer),
  debit: addIdentityTerminalCosts(controls, validation, c.insertTicket, c.debitOriginal),
  effect: addIdentityTerminalCosts(controls, validation, m.tickets, m.deleteTickets,
    m.deleteMaintenance, c.deleteOriginal, m.complete, c.provenanceBinding, c.releaseCopies, c.emptySlot),
});
export const IDENTITY_TERMINAL_MAINTENANCE_TOTAL = addIdentityTerminalCosts(
  IDENTITY_TERMINAL_MAINTENANCE_PLAN.admission, IDENTITY_TERMINAL_MAINTENANCE_PLAN.debit,
  IDENTITY_TERMINAL_MAINTENANCE_PLAN.effect,
);
