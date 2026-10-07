import type { LoanListItem } from './types.ts';

/**
 * Overdue and still due follow the loan state the API already assigned.
 * A calendar day does not move a loan between these groups.
 */
export function loanSections(items: readonly LoanListItem[]): { overdue: LoanListItem[]; due: LoanListItem[] } {
  return {
    overdue: items.filter(item => item.loan.state === 'overdue'),
    due: items.filter(item => item.loan.state === 'open'),
  };
}
