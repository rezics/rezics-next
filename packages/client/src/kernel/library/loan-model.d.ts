import { type LoanDueBoundary } from './loan-date.ts';
export { LoanInvalidError } from './loan-date.ts';
export declare const MAX_LOAN_PARTY_SCALARS = 300;
export declare const MAX_LOAN_REVISION = 2147483647;
/** Explicit selection only. A private name never resolves to a person reference. */
export type LoanCounterparty = Readonly<{
    kind: 'name';
    name: string;
}> | Readonly<{
    kind: 'person';
    personId: string;
}>;
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
export type LoanExtend = Readonly<{
    revision: number;
    dueOn: string;
}>;
export type LoanReturn = Readonly<{
    revision: number;
    returnedOn: string;
}>;
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
export declare class LoanConflictError extends Error {
    readonly reason: 'stale_revision' | 'returned' | 'revision_exhausted' | 'copy_unavailable';
    constructor(reason: 'stale_revision' | 'returned' | 'revision_exhausted' | 'copy_unavailable');
}
export declare class LoanNotFoundError extends Error {
    constructor();
}
/** Capture a detached, immutable operand before native dispatch; never recapture it after uncertainty. */
export declare function parseLoanCreate(input: unknown): LoanCreate;
export declare function parseLoanExtend(input: unknown): LoanExtend;
export declare function parseLoanReturn(input: unknown): LoanReturn;
/** Conceal foreign identities before comparing revisions. Equal routes alone never establish ownership. */
export declare function assertLoanOwner(accountId: string, loan: Pick<Loan, 'id' | 'accountId' | 'copyId'>): void;
/** This is an operand check, not copy eligibility or authorization. The native command must lock the live copy. */
export declare function assertLoanCopyOperand(accountId: string, input: LoanCreate, copy: Readonly<{
    id: string;
    accountId: string;
    revision: number;
    disposedOn: string | null;
    status: string;
}> | null): void;
/** Pure fresh-create result. Native commands separately own admission, eligibility, locks, indexes and receipts. */
export declare function createLoanRecord(identity: Readonly<{
    id: string;
    accountId: string;
}>, input: LoanCreate): Loan;
/** Extend an open loan, or assign its first due date. Clearing or shortening a date is not extension. */
export declare function extendLoanRecord(current: Loan, input: LoanExtend): Loan;
/** Record the actual return day, including early return. A receipt replay must return its stored original result. */
export declare function returnLoanRecord(current: Loan, input: LoanReturn, boundary: LoanDueBoundary): Loan;
export declare function loanState(loan: Pick<Loan, 'dueOn' | 'returnedOn'>, boundary: LoanDueBoundary): LoanState;
