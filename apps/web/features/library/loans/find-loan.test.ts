import { describe, expect, test } from 'bun:test';
import { mainCopiesApi } from './api.ts';
import type { LoanRecord, RecordPage } from './types.ts';

function loan(id: string, state: LoanRecord['state'] = 'open'): LoanRecord {
  return { id, copy: 'https://rezics.com/id/00000000-0000-4000-8000-0000000000c0', direction: 'lent',
    counterparty: { kind: 'name', name: 'City Library' }, startedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-10-01T12:00:00.000Z', returnedAt: state === 'returned' ? '2026-10-02T00:00:00.000Z' : null,
    version: 4, changedAt: '2026-09-02T00:00:00.000Z', state };
}

function page(items: LoanRecord[], nextCursor: string | null): RecordPage<LoanRecord> {
  return { items, nextCursor, complete: nextCursor === null };
}

/** Main answers one page per state and cursor. The loan under test is never on the first page. */
function paged(active: RecordPage<LoanRecord>[], returned: RecordPage<LoanRecord>[]) {
  const reads: string[] = [];
  const api = mainCopiesApi('https://rezics.com/id/agent', () => ({
    v1: { me: { 'library-loans': { get: async ({ query }: { query: { state?: string; cursor?: string } }) => {
      const list = query.state === 'returned' ? returned : active;
      const index = query.cursor ? list.findIndex(item => item.nextCursor === query.cursor) + 1 : 0;
      reads.push(`${query.state ?? 'active'}:${query.cursor ?? ''}`);
      const data = list[index];
      return data ? { data, error: null } : { data: null, error: { status: 404, value: {} } };
    } } } },
  }) as never);
  return { api, reads };
}

describe('stale loan recovery', () => {
  test('finds a loan that is only on a later active page', async () => {
    const later = loan('https://rezics.com/id/00000000-0000-4000-8000-000000000021');
    const first = Array.from({ length: 20 }, (_, index) => loan(`https://rezics.com/id/00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`));
    const { api, reads } = paged([page(first, 'page-2'), page([later], null)], [page([], null)]);
    const found = await api.findLoan(later.id);
    expect(found).toEqual({ ok: true, data: later });
    expect(reads).toContain('active:page-2');
  });

  test('finds a returned loan that is only on a later returned page', async () => {
    const later = loan('https://rezics.com/id/00000000-0000-4000-8000-000000000099', 'returned');
    const { api } = paged([page([], null)], [page([], 'returned-2'), page([later], null)]);
    const found = await api.findLoan(later.id);
    expect(found).toEqual({ ok: true, data: later });
  });
});
