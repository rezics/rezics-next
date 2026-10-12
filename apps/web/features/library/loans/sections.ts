import type { LoanListItem } from './types.ts';

/**
 * Overdue and still due follow the loan state the API already assigned.
 * A calendar day does not move a loan between these groups. The API lists active
 * loans by due date across every page, so within each group the order is the
 * API's own, not an order of the loaded rows: an overdue loan never waits on a
 * later page behind one that is still due.
 */
export function loanSections(items: readonly LoanListItem[]): { overdue: LoanListItem[]; due: LoanListItem[] } {
  return {
    overdue: items.filter(item => item.loan.state === 'overdue'),
    due: items.filter(item => item.loan.state === 'open'),
  };
}
