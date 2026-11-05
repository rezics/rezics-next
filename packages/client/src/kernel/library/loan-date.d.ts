/** Loan dates are complete Gregorian calendar days, never timestamps. */
export declare class LoanInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
/** Validate without Date's normalization, timezone conversion or special handling of years 0–99. */
export declare function loanDate(value: unknown, field: string): string;
export type LoanDueBoundary = Readonly<{
    calendar: 'gregorian';
    zone: 'UTC';
    today: string;
}>;
/** Evaluate once from server authoritative time and reuse for every row in the response. */
export declare function loanDueBoundary(at: Date): LoanDueBoundary;
/** A due day is inclusive: it becomes overdue on the following UTC calendar day. */
export declare function loanIsOverdue(dueOn: string | null, boundary: LoanDueBoundary): boolean;
