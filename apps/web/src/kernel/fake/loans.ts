import type { Loan, LoanPage } from '@rezics/client';
import type { FakeRoute } from '../fake-modules';

/** Illustrative contracts, not recorded native acceptance or a second loan implementation. */
export type LoansStoryMode = 'open' | 'history' | 'concealed' | 'uncertain' | 'conflict' | 'copy';
export const loanStoryBoundary: LoanPage['boundary'] = { calendar: 'gregorian', zone: 'UTC', today: '2026-11-14' };
const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const availableAction = { allowed: true, reason: null } as const;
const returnedAction = { allowed: false, reason: 'returned' } as const;

export function illustrativeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: id(1), copyId: '01a17a3b-700b-7781-9456-f4cc234fc6cc', revision: 3, direction: 'lent',
    counterparty: { kind: 'name', name: '  Camille — private loan note  ' },
    startedOn: '2026-11-01', dueOn: '2026-11-10', returnedOn: null,
    state: 'overdue', viewer: { state: 'owner' }, actions: { extend: availableAction, return: availableAction },
    ...overrides,
  };
}
const item = (loan: Loan, title: string): LoanPage['items'][number] => ({
  loan,
  copy: {
    state: 'available', id: loan.copyId, revision: 7, kind: 'physical', status: 'owned',
    context: { state: 'available', work: [{ id: id(101), labels: { en: title } }], facts: {} },
  },
});
export function illustrativeLoanPage(mode: LoansStoryMode): LoanPage {
  let items: LoanPage['items'] = [
    item(illustrativeLoan(), 'The Little Prince'),
    item(illustrativeLoan({ id: id(2), copyId: id(12), direction: 'borrowed', dueOn: '2026-11-14', state: 'due',
      counterparty: { kind: 'name', name: 'Mira at the neighbourhood reading group' } }), 'Kokoro'),
    item(illustrativeLoan({ id: id(3), copyId: id(13), dueOn: null, state: 'undated' }), 'A long illustrated collection of stories for the whole reading group'),
  ];
  if (mode === 'history') {
    const returned = illustrativeLoan({ returnedOn: '2026-11-13', state: 'returned', actions: { extend: returnedAction, return: returnedAction } });
    items = [
      { ...item(returned, ''), copy: { state: 'deleted', id: returned.copyId, revision: null, kind: null, status: null, context: { state: 'missing' } } },
      { ...item({ ...returned, id: id(2), copyId: id(12), returnedOn: '2026-11-12' }, ''), copy: { state: 'missing', id: id(12), revision: null, kind: null, status: null, context: { state: 'missing' } } },
    ];
  } else if (mode === 'concealed') {
    items = items.map((row, index) => ({
      ...row,
      loan: { ...row.loan, counterparty: { kind: 'person', state: 'concealed' } },
      copy: { ...row.copy, context: index === 0 ? { state: 'withheld' } : index === 1 ? { state: 'scope' } : { state: 'unsupported', facts: {} } },
    }));
  } else if (mode === 'copy') items = [];
  else if (mode === 'uncertain' || mode === 'conflict') items = items.slice(0, 1);
  return { filter: mode === 'history' ? 'history' : 'open', boundary: loanStoryBoundary, generation: 1, items, nextCursor: null };
}

let mode: LoansStoryMode | undefined;
let page: LoanPage | undefined;
let lost = false;
let conflicted = false;
const receipts = new Map<string, { body: string; loan: Loan }>();

export function setLoansStoryMode(next: LoansStoryMode) {
  mode = next;
  page = illustrativeLoanPage(next);
  lost = false;
  conflicted = false;
  receipts.clear();
}
export function resetLoansStoryMode() {
  mode = undefined;
  page = undefined;
  receipts.clear();
}
const conflict = { status: 409, code: 'conflict', type: 'https://rezics.com/problems/conflict' };
const unavailable = { status: 503, code: 'unavailable', type: 'https://rezics.com/problems/unavailable' };

async function write(request: Request, operation: 'create' | 'extend' | 'return') {
  if (!mode || !page) return;
  const input = await request.json();
  const key = request.headers.get('idempotency-key') ?? '';
  const body = JSON.stringify({ operation, path: new URL(request.url).pathname, input });
  const receipt = receipts.get(key);
  if (receipt) return receipt.body === body ? { status: 200, loan: receipt.loan, boundary: loanStoryBoundary } : conflict;
  const loanId = new URL(request.url).pathname.split('/')[3];
  const row = page.items.find((row) => row.loan.id === loanId);
  if (mode === 'conflict' && !conflicted && row) {
    conflicted = true;
    page = { ...page, generation: page.generation + 1, items: page.items.map((item) => item === row
      ? { ...item, loan: { ...item.loan, revision: item.loan.revision + 1, dueOn: '2026-12-01', state: 'due' } } : item) };
    return conflict;
  }
  let loan: Loan;
  if (operation === 'create') {
    loan = illustrativeLoan({ id: id(50), copyId: input.copyId, revision: 1, direction: input.direction,
      counterparty: input.counterparty, startedOn: input.startedOn, dueOn: input.dueOn ?? null,
      state: input.dueOn ? 'due' : 'undated' });
    page = { ...page, generation: page.generation + 1, items: [item(loan, 'The Little Prince')] };
  } else {
    if (!row || row.loan.returnedOn || row.loan.revision !== input.revision) return conflict;
    loan = { ...row.loan, revision: row.loan.revision + 1,
      ...(operation === 'extend' ? { dueOn: input.dueOn, state: 'due' as const }
        : { returnedOn: input.returnedOn, state: 'returned' as const, actions: { extend: returnedAction, return: returnedAction } }),
    };
    page = { ...page, generation: page.generation + 1, items: page.items.map((item) => item === row ? { ...item, loan } : item) };
  }
  receipts.set(key, { body, loan });
  if (mode === 'uncertain' && !lost) { lost = true; return unavailable; }
  return { status: 200, loan, boundary: loanStoryBoundary };
}

export const routes: FakeRoute[] = [
  { method: 'GET', path: '/v1/copy-loans', story: ({ request }) => {
    if (!mode || !page) return;
    const filter = new URL(request.url).searchParams.get('filter') === 'history' ? 'history' : 'open';
    return { status: 200, ...page, filter,
      items: page.items.filter((item) => filter === 'history' ? !!item.loan.returnedOn : !item.loan.returnedOn),
    };
  } },
  { method: 'POST', path: '/v1/copy-loans', story: ({ request }) => write(request, 'create') },
  { method: 'PATCH', path: /^\/v1\/copy-loans\/[^/]+$/, story: ({ request }) => write(request, 'extend') },
  { method: 'POST', path: /^\/v1\/copy-loans\/[^/]+\/return$/, story: ({ request }) => write(request, 'return') },
];
