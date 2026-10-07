import type { CopyDraft, CopyRecord, LoanDraft, LoanRecord, PersonCard, RecordPage, RecordResult,
  ReleaseChoice } from './types.ts';
import type { CopiesApi } from './api.ts';

export interface MemoryCopies {
  /** The Work these releases and new copies belong to. */
  work: string;
  now: number;
  releases: ReleaseChoice[];
  copies: CopyRecord[];
  loans: LoanRecord[];
  /** Handles passed to `person`. A saved name must not appear here. */
  personLookups: string[];
  people: PersonCard[];
  /** The next create or open fails once with a stale version, then succeeds. */
  failOnce?: 'create' | 'open' | 'extend' | 'return';
}

const page = <T>(items: T[]): RecordPage<T> => ({ items, nextCursor: null, complete: true });
const PAGE_LIMIT = 20;

function slicePage<T>(items: readonly T[], cursor?: string | null): RecordPage<T> {
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const next = items.slice(start, start + PAGE_LIMIT);
  const end = start + next.length;
  const nextCursor = end < items.length ? String(end) : null;
  return { items: [...next], nextCursor, complete: nextCursor === null };
}

function loanState(loan: Pick<LoanRecord, 'returnedAt' | 'dueAt'>, now: number): LoanRecord['state'] {
  if (loan.returnedAt) return 'returned';
  return Date.parse(loan.dueAt) < now ? 'overdue' : 'open';
}

/** An in-memory Main for stories. It keeps the compare-and-set versions the write lane reads back. */
export function memoryCopiesApi(seed: Partial<MemoryCopies> = {}): CopiesApi & { state: MemoryCopies } {
  const state: MemoryCopies = { work: seed.work ?? '', now: seed.now ?? Date.now(), releases: seed.releases ?? [],
    copies: seed.copies ?? [], loans: seed.loans ?? [], personLookups: [], people: seed.people ?? [],
    failOnce: seed.failOnce };
  const take = (kind: NonNullable<MemoryCopies['failOnce']>): RecordResult<never> | null => {
    if (state.failOnce !== kind) return null;
    state.failOnce = undefined;
    return { ok: false, failure: 'moved' };
  };
  const api: CopiesApi & { state: MemoryCopies } = {
    state,
    releases: async (_work, cursor) => ({ ok: true, data: slicePage(state.releases, cursor) }),
    copies: async (work, cursor) => ({ ok: true, data: slicePage(state.copies.filter(copy => copy.work === work && !copy.removed), cursor) }),
    async createCopy(draft: CopyDraft) {
      const failed = take('create');
      if (failed) return failed;
      const copy: CopyRecord = { id: `https://rezics.com/id/${crypto.randomUUID()}`, work: state.work,
        release: draft.release, format: draft.format, acquiredFrom: draft.acquiredFrom, acquiredAt: draft.acquiredAt,
        ownedFrom: draft.ownedFrom, ownedThrough: null, removed: false, version: 1,
        changedAt: new Date(state.now).toISOString() };
      state.copies.push(copy);
      return { ok: true, data: copy };
    },
    async loans(query) {
      const items = state.loans.filter(loan => !query?.state || (query.state === 'active'
        ? loan.state !== 'returned' : loan.state === query.state));
      return { ok: true, data: page(items) };
    },
    async openLoan(draft: LoanDraft) {
      const failed = take('open');
      if (failed) return failed;
      if (state.loans.some(loan => loan.copy === draft.copy && !loan.returnedAt)) return { ok: false, failure: 'conflict' };
      const loan: LoanRecord = { id: `https://rezics.com/id/${crypto.randomUUID()}`, copy: draft.copy,
        direction: draft.direction, counterparty: draft.counterparty, startedAt: draft.startedAt, dueAt: draft.dueAt,
        returnedAt: null, version: 1, changedAt: new Date(state.now).toISOString(),
        state: loanState({ returnedAt: null, dueAt: draft.dueAt }, state.now) };
      state.loans.push(loan);
      return { ok: true, data: loan };
    },
    async extendLoan(id, expectedVersion, dueAt) {
      const failed = take('extend');
      if (failed) return failed;
      const loan = state.loans.find(item => item.id === id);
      if (!loan) return { ok: false, failure: 'missing' };
      if (loan.version !== expectedVersion) return { ok: false, failure: 'moved' };
      if (loan.returnedAt) return { ok: false, failure: 'conflict' };
      if (dueAt <= loan.dueAt) return { ok: false, failure: 'invalid' };
      loan.dueAt = dueAt;
      loan.version += 1;
      loan.state = loanState(loan, state.now);
      return { ok: true, data: { ...loan } };
    },
    async returnLoan(id, expectedVersion) {
      const failed = take('return');
      if (failed) return failed;
      const loan = state.loans.find(item => item.id === id);
      if (!loan) return { ok: false, failure: 'missing' };
      if (loan.version !== expectedVersion) return { ok: false, failure: 'moved' };
      if (loan.returnedAt) return { ok: false, failure: 'conflict' };
      loan.returnedAt = new Date(state.now).toISOString();
      loan.version += 1;
      loan.state = 'returned';
      return { ok: true, data: { ...loan } };
    },
    async findLoan(id) {
      return { ok: true, data: state.loans.find(loan => loan.id === id) ?? null };
    },
    async person(handle) {
      state.personLookups.push(handle);
      const found = state.people.find(person => person.handle === handle);
      return { ok: true, data: found ?? null };
    },
  };
  return api;
}
