import { isCalendarDate } from '@rezics/filter';

/** Loan dates are complete Gregorian calendar days, never timestamps. */
export class LoanInvalidError extends Error {
  constructor(readonly field: string) {
    super(`Invalid loan field: ${field}`);
    this.name = 'LoanInvalidError';
  }
}

/** Validate without Date's normalization, timezone conversion or special handling of years 0–99. */
export function loanDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new LoanInvalidError(field);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || !isCalendarDate({ year, month, day })) throw new LoanInvalidError(field);
  return value;
}

export type LoanDueBoundary = Readonly<{ calendar: 'gregorian'; zone: 'UTC'; today: string }>;

/** Evaluate once from server authoritative time and reuse for every row in the response. */
export function loanDueBoundary(at: Date): LoanDueBoundary {
  if (!Number.isFinite(at.getTime())) throw new RangeError('Invalid loan boundary time');
  return Object.freeze({ calendar: 'gregorian', zone: 'UTC', today: loanDate(at.toISOString().slice(0, 10), 'today') });
}

/** A due day is inclusive: it becomes overdue on the following UTC calendar day. */
export function loanIsOverdue(dueOn: string | null, boundary: LoanDueBoundary): boolean {
  return dueOn !== null && dueOn < boundary.today;
}
