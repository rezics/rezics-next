import { describe, expect, test } from 'bun:test';
import { loanSections } from './sections.ts';
import type { LoanListItem, LoanRecord } from './types.ts';

function item(dueAt: string, state: LoanRecord['state'], id: string): LoanListItem {
  const loan: LoanRecord = {
    id, copy: `${id}-copy`, direction: 'lent', counterparty: { kind: 'name', name: 'City Library' },
    startedAt: '2026-09-01T00:00:00.000Z', dueAt, returnedAt: null, version: 1,
    changedAt: '2026-09-28T12:00:00.000Z', state,
  };
  return { loan, work: null, edition: null, format: null, personName: null };
}

describe('loan sections', () => {
  test('a loan the API calls overdue is overdue on any calendar day', () => {
    const overdueToday = item('2026-09-28T01:00:00.000Z', 'overdue', 'https://rezics.com/id/today');
    const overdueLater = item('2099-01-01T00:00:00.000Z', 'overdue', 'https://rezics.com/id/later');
    const openEarlier = item('2020-01-01T00:00:00.000Z', 'open', 'https://rezics.com/id/earlier');
    const sections = loanSections([openEarlier, overdueToday, overdueLater]);
    expect(sections.overdue).toEqual([overdueToday, overdueLater]);
    expect(sections.due).toEqual([openEarlier]);
  });
});
