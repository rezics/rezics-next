import { routeOf } from '../route/route.ts';
import { loanDate, loanIsOverdue, LoanInvalidError, type LoanDueBoundary } from './loan-date.ts';

export { LoanInvalidError } from './loan-date.ts';
export const MAX_LOAN_PARTY_SCALARS = 300;
export const MAX_LOAN_REVISION = 2_147_483_647;

/** Explicit selection only. A private name never resolves to a person reference. */
export type LoanCounterparty =
  | Readonly<{ kind: 'name'; name: string }>
  | Readonly<{ kind: 'person'; personId: string }>;
export type LoanDirection = 'lent' | 'borrowed';
export type LoanState = 'overdue' | 'due' | 'undated' | 'returned';

export type LoanCreate = Readonly<{
  copyId: string;
  copyRevision: number;
  direction: LoanDirection;
  counterparty: LoanCounterparty;
  startedOn: string;
  dueOn: string | null;
}>;
export type LoanExtend = Readonly<{ revision: number; dueOn: string }>;
export type LoanReturn = Readonly<{ revision: number; returnedOn: string }>;

/** Native identity has an owner route and points to one exact copy, independently of its work. */
export type Loan = Readonly<{
  id: string;
  accountId: string;
  copyId: string;
  direction: LoanDirection;
  counterparty: LoanCounterparty;
  startedOn: string;
  dueOn: string | null;
  returnedOn: string | null;
  revision: number;
}>;

export class LoanConflictError extends Error {
  constructor(readonly reason: 'stale_revision' | 'returned' | 'revision_exhausted' | 'copy_unavailable') {
    super(`Loan conflict: ${reason}`);
    this.name = 'LoanConflictError';
  }
}

export class LoanNotFoundError extends Error {
  constructor() {
    super('Loan or copy not found');
    this.name = 'LoanNotFoundError';
  }
}

function object(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LoanInvalidError(field);
  const data = value as Record<string, unknown>;
  // Bound and close each operand before examining nested values. No caller-supplied owner or revision is dropped.
  for (const key of Object.keys(data)) {
    if (!fields.includes(key)) throw new LoanInvalidError(field === 'loan' ? key : `${field}.${key}`);
  }
  return data;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || routeOf(value) === null) throw new LoanInvalidError(field);
  return value;
}

function revision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LOAN_REVISION)
    throw new LoanInvalidError(field);
  return value;
}

function counterparty(input: unknown): LoanCounterparty {
  const data = object(input, 'counterparty', ['kind', 'name', 'personId']);
  if (data.kind === 'person') {
    if (Object.hasOwn(data, 'name')) throw new LoanInvalidError('counterparty.name');
    return Object.freeze({ kind: 'person', personId: identity(data.personId, 'counterparty.personId') });
  }
  if (data.kind !== 'name') throw new LoanInvalidError('counterparty.kind');
  if (Object.hasOwn(data, 'personId')) throw new LoanInvalidError('counterparty.personId');
  const name = data.name;
  if (
    typeof name !== 'string' ||
    name.length > MAX_LOAN_PARTY_SCALARS * 2 ||
    name.trim().length === 0 ||
    !name.isWellFormed() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
    [...name].length > MAX_LOAN_PARTY_SCALARS
  )
    throw new LoanInvalidError('counterparty.name');
  // Preserve exact private text, including spaces and Unicode composition, in the original receipt operand.
  return Object.freeze({ kind: 'name', name });
}

function dates(startedOn: string, dueOn: string | null): void {
  if (dueOn !== null && dueOn < startedOn) throw new LoanInvalidError('dueOn');
}

/** Capture a detached, immutable operand before native dispatch; never recapture it after uncertainty. */
export function parseLoanCreate(input: unknown): LoanCreate {
  const data = object(input, 'loan', ['copyId', 'copyRevision', 'direction', 'counterparty', 'startedOn', 'dueOn']);
  if (data.direction !== 'lent' && data.direction !== 'borrowed') throw new LoanInvalidError('direction');
  const startedOn = loanDate(data.startedOn, 'startedOn');
  const dueOn = data.dueOn === null || !Object.hasOwn(data, 'dueOn') ? null : loanDate(data.dueOn, 'dueOn');
  dates(startedOn, dueOn);
  return Object.freeze({
    copyId: identity(data.copyId, 'copyId'),
    copyRevision: revision(data.copyRevision, 'copyRevision'),
    direction: data.direction,
    counterparty: counterparty(data.counterparty),
    startedOn,
    dueOn,
  });
}

export function parseLoanExtend(input: unknown): LoanExtend {
  const data = object(input, 'loan', ['revision', 'dueOn']);
  return Object.freeze({ revision: revision(data.revision, 'revision'), dueOn: loanDate(data.dueOn, 'dueOn') });
}

export function parseLoanReturn(input: unknown): LoanReturn {
  const data = object(input, 'loan', ['revision', 'returnedOn']);
  return Object.freeze({
    revision: revision(data.revision, 'revision'),
    returnedOn: loanDate(data.returnedOn, 'returnedOn'),
  });
}

/** Conceal foreign identities before comparing revisions. Equal routes alone never establish ownership. */
export function assertLoanOwner(accountId: string, loan: Pick<Loan, 'id' | 'accountId' | 'copyId'>): void {
  const route = routeOf(accountId);
  if (route === null || loan.accountId !== accountId || routeOf(loan.id) !== route || routeOf(loan.copyId) !== route)
    throw new LoanNotFoundError();
}

/** This is an operand check, not copy eligibility or authorization. The native command must lock the live copy. */
export function assertLoanCopyOperand(
  accountId: string,
  input: LoanCreate,
  copy: Readonly<{
    id: string;
    accountId: string;
    revision: number;
    disposedOn: string | null;
    status: string;
  }> | null,
): void {
  if (
    !copy ||
    routeOf(accountId) === null ||
    routeOf(input.copyId) !== routeOf(accountId) ||
    copy.id !== input.copyId ||
    copy.accountId !== accountId
  )
    throw new LoanNotFoundError();
  if (copy.revision !== input.copyRevision) throw new LoanConflictError('stale_revision');
  if (copy.disposedOn !== null || copy.status === 'disposed') throw new LoanConflictError('copy_unavailable');
}

function immutable(loan: Loan): Loan {
  return Object.freeze({ ...loan, counterparty: Object.freeze({ ...loan.counterparty }) });
}

/** Pure fresh-create result. Native commands separately own admission, eligibility, locks, indexes and receipts. */
export function createLoanRecord(identity: Readonly<{ id: string; accountId: string }>, input: LoanCreate): Loan {
  const loan: Loan = {
    id: identity.id,
    accountId: identity.accountId,
    copyId: input.copyId,
    direction: input.direction,
    counterparty: input.counterparty,
    startedOn: input.startedOn,
    dueOn: input.dueOn,
    returnedOn: null,
    revision: 1,
  };
  assertLoanOwner(identity.accountId, loan);
  return immutable(loan);
}

function writable(current: Loan, expected: number): void {
  if (current.revision !== expected) throw new LoanConflictError('stale_revision');
  if (current.returnedOn !== null) throw new LoanConflictError('returned');
  if (current.revision === MAX_LOAN_REVISION) throw new LoanConflictError('revision_exhausted');
}

/** Extend an open loan, or assign its first due date. Clearing or shortening a date is not extension. */
export function extendLoanRecord(current: Loan, input: LoanExtend): Loan {
  writable(current, input.revision);
  dates(current.startedOn, input.dueOn);
  if (current.dueOn !== null && input.dueOn <= current.dueOn) throw new LoanInvalidError('dueOn');
  return immutable({ ...current, dueOn: input.dueOn, revision: current.revision + 1 });
}

/** Record the actual return day, including early return. A receipt replay must return its stored original result. */
export function returnLoanRecord(current: Loan, input: LoanReturn, boundary: LoanDueBoundary): Loan {
  writable(current, input.revision);
  if (input.returnedOn < current.startedOn || input.returnedOn > boundary.today)
    throw new LoanInvalidError('returnedOn');
  return immutable({ ...current, returnedOn: input.returnedOn, revision: current.revision + 1 });
}

export function loanState(loan: Pick<Loan, 'dueOn' | 'returnedOn'>, boundary: LoanDueBoundary): LoanState {
  if (loan.returnedOn !== null) return 'returned';
  if (loan.dueOn === null) return 'undated';
  return loanIsOverdue(loan.dueOn, boundary) ? 'overdue' : 'due';
}
