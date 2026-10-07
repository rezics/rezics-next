import { sameParty } from './party.ts';
import type { CopyChange, CopyDraft, CopyRecord, LoanDraft, LoanRecord } from './types.ts';

/**
 * A stored record is the command's outcome only when every field that command
 * sets agrees. A shared release, party or due date is not enough: the rest of
 * the intent may still differ, and that is a conflict.
 */

export function savedCopyMatches(current: CopyRecord, choice: CopyDraft): boolean {
  return !current.removed && current.ownedThrough === null && current.release === choice.release
    && current.format === choice.format && sameParty(current.acquiredFrom, choice.acquiredFrom)
    && current.acquiredAt === choice.acquiredAt && current.ownedFrom === choice.ownedFrom;
}

export function changedCopyMatches(current: CopyRecord, choice: CopyChange): boolean {
  if (current.removed) return false;
  if (choice.format !== undefined && current.format !== choice.format) return false;
  if (choice.acquiredFrom !== undefined && !sameParty(current.acquiredFrom, choice.acquiredFrom)) return false;
  if (choice.acquiredAt !== undefined && current.acquiredAt !== choice.acquiredAt) return false;
  if (choice.ownedFrom !== undefined && current.ownedFrom !== choice.ownedFrom) return false;
  if (choice.ownedThrough !== undefined && current.ownedThrough !== choice.ownedThrough) return false;
  return true;
}

export function removedCopyMatches(current: CopyRecord): boolean {
  return current.removed;
}

export function openedLoanMatches(current: LoanRecord, choice: LoanDraft): boolean {
  return current.returnedAt === null && current.copy === choice.copy && current.direction === choice.direction
    && sameParty(current.counterparty, choice.counterparty) && current.startedAt === choice.startedAt
    && current.dueAt === choice.dueAt;
}

export function extendedLoanMatches(current: LoanRecord, dueAt: string): boolean {
  return current.returnedAt === null && current.dueAt === dueAt;
}

export function returnedLoanMatches(current: LoanRecord): boolean {
  return current.returnedAt !== null;
}
