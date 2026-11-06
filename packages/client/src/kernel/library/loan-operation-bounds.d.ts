import { type Bound } from '@rezics/bounds';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Actor } from '../request/access.ts';
import { type Loan } from './loan-model.ts';
export declare const MAX_OPEN_LOAN_PAGE = 100;
export declare const MAX_HISTORY_LOAN_PAGE = 50;
export declare const MAX_LOAN_GENERATION = 2147483647;
export type LoanHttpOperation = 'list' | 'create' | 'extend' | 'return';
export type LoanHttpWorkContext = Readonly<{
    operation: LoanHttpOperation;
    request: Request;
    actor: Actor;
    deadline: number;
    input: unknown;
    workerAllowance: 0;
}>;
export type LoanHttpWorkOwner = <T>(context: LoanHttpWorkContext, dispatch: () => Promise<T>) => Promise<T>;
/** The route forwards the existing request frame; only its manifest owner can bind funding. */
export declare function withLoanHttpWork<T>(owner: LoanHttpWorkOwner | undefined, context: LoanHttpWorkContext, dispatch: () => Promise<T>): Promise<T>;
type Operand = string | number | null;
type Point = Readonly<{
    route: number;
    accountId: string;
    id: string;
}>;
type Generation = Readonly<{
    route: number;
    accountId: string;
}>;
/** Local native SQL only. Enclosing admission, command and presentation work is independent. */
export type LoanNativePlan<Row extends QueryResultRow> = Readonly<{
    kind: 'copy-lock' | 'loan-copy' | 'loan-lock' | 'open-loan' | 'generation' | 'advance-generation' | 'insert' | 'update' | 'copy-read' | 'loan-read' | 'loan-cursor' | 'loan-page-first' | 'loan-page-dated' | 'loan-page-undated' | 'loan-history-first' | 'loan-history-next';
    sql: string;
    operands: readonly Operand[];
    total: Bound;
    result?: Row;
}>;
export type LoanPageSeek = Readonly<{
    day: string;
    id: string;
    undated?: boolean;
}>;
export type LoanNativeRow = QueryResultRow & {
    loanId: string;
    accountId: string;
    copyId: string;
    direction: 'lent' | 'borrowed';
    counterpartyKind: 'name' | 'person';
    counterpartyName: string | null;
    counterpartyPersonId: string | null;
    startedOn: string | Date;
    dueOn: string | Date | null;
    returnedOn: string | Date | null;
    revision: number;
    copySubjectId: string | null;
    copyRevision: number | null;
    copyKind: string | null;
    copyStatus: string | null;
    copyDisposedOn: string | Date | null;
    copyDeletionId: string | null;
};
export type LoanPageInput = Readonly<{
    route: number;
    accountId: string;
    filter: 'open' | 'history';
    limit: number;
    after: LoanPageSeek | null;
}>;
export declare function loanCopyReadPlan(input: Point): LoanNativePlan<{
    copyId: string;
}>;
export declare function loanReadPlan(input: Point): LoanNativePlan<LoanNativeRow>;
export declare function loanCursorDuePlan(input: Point): LoanNativePlan<{
    dueOn: string | Date | null;
}>;
export declare function loanPagePlan(input: LoanPageInput): LoanNativePlan<LoanNativeRow>;
export declare function loanCopyLockPlan(input: Point): LoanNativePlan<{
    copy_id: string;
}>;
export declare function loanCopyLocatorPlan(input: Point): LoanNativePlan<{
    copyId: string;
}>;
export declare function loanLockPlan(input: Point): LoanNativePlan<{
    loan_id: string;
}>;
export declare function loanOpenProbePlan(input: Point): LoanNativePlan<{
    loan_id: string;
}>;
export declare function loanGenerationPlan(input: Generation): LoanNativePlan<{
    generation: number;
}>;
export declare function loanAdvanceGenerationPlan(input: Generation): LoanNativePlan<{
    generation: number;
}>;
export declare function loanInsertPlan(loan: Loan, command: Readonly<{
    time: string;
    transactionId: string;
}>): LoanNativePlan<QueryResultRow>;
export declare function loanUpdatePlan(current: Loan, next: Loan, command: Readonly<{
    time: string;
    transactionId: string;
}>): LoanNativePlan<QueryResultRow>;
/** Consume before dispatch on the caller's live frame and original client. No new admission. */
export declare function executeLoanNative<Row extends QueryResultRow>(client: Pick<PoolClient, 'query'>, declaration: LoanNativePlan<Row>): Promise<import("pg").QueryResult<Row>>;
export {};
