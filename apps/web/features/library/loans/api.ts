import { browserMainApi } from '../../api/browser.ts';
import type { MainClient } from '../../discover/types.ts';
import { commandKey } from '../../feed/api.ts';
import { asCopy, asLoan, asPage, asRelease } from './shape.ts';
import type { CopyDraft, CopyRecord, LoanDraft, LoanRecord, PersonCard, RecordFailure, RecordPage, RecordResult,
  ReleaseChoice } from './types.ts';

// Browser commands for the reader's own copies and loans. Each write names
// the session's Agent, the version it read, and its own idempotency key.
// Stories pass a `CopiesApi` that keeps the same shapes in memory.

const headers = () => ({ headers: { 'idempotency-key': commandKey() } });
const uuid = (iri: string) => iri.slice(-36);
/** Active and returned lists are each walked this many pages while recovering one loan. */
const LOAN_SEARCH_PAGES = 200;

function recordFailure(status: number, body: unknown): RecordFailure {
  const code = body && typeof body === 'object' && 'code' in body ? String((body as { code: unknown }).code) : '';
  if (status === 409) return code === 'library_record_conflict' ? 'conflict' : 'moved';
  if (status === 404) return 'missing';
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 400 || status === 422) return 'invalid';
  return 'unavailable';
}

async function call<T>(run: () => Promise<{ data: T | null; error: { status: number; value: unknown } | null }>):
  Promise<RecordResult<T>> {
  try {
    const { data, error } = await run();
    if (error) return { ok: false, failure: recordFailure(error.status, error.value) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}


export interface CopiesApi {
  releases(work: string, cursor?: string | null): Promise<RecordResult<RecordPage<ReleaseChoice>>>;
  copies(work: string, cursor?: string | null): Promise<RecordResult<RecordPage<CopyRecord>>>;
  createCopy(draft: CopyDraft): Promise<RecordResult<CopyRecord>>;
  loans(query?: { state?: 'active' | 'overdue' | 'returned'; cursor?: string | null }):
    Promise<RecordResult<RecordPage<LoanRecord>>>;
  openLoan(draft: LoanDraft): Promise<RecordResult<LoanRecord>>;
  extendLoan(id: string, expectedVersion: number, dueAt: string): Promise<RecordResult<LoanRecord>>;
  returnLoan(id: string, expectedVersion: number): Promise<RecordResult<LoanRecord>>;
  /** The loan on any active page, then any returned page. */
  findLoan(id: string): Promise<RecordResult<LoanRecord | null>>;
  /** A handle the reader asked to use as a person. Names are never passed here. */
  person(handle: string): Promise<RecordResult<PersonCard | null>>;
}

export function mainCopiesApi(actingSubject: string, main: () => MainClient = browserMainApi): CopiesApi {
  const pageOf = <T>(value: RecordResult<unknown>, item: (value: unknown) => T | null): RecordResult<RecordPage<T>> => {
    if (!value.ok) return value;
    const page = asPage(value.data, item);
    return page ? { ok: true, data: page } : { ok: false, failure: 'unavailable' };
  };
  const one = <T>(value: RecordResult<unknown>, item: (value: unknown) => T | null): RecordResult<T> => {
    if (!value.ok) return value;
    const parsed = item(value.data);
    return parsed ? { ok: true, data: parsed } : { ok: false, failure: 'unavailable' };
  };

  const api: CopiesApi = {
    async releases(work, cursor) {
      const read = await call(() => main().v1.works({ id: uuid(work) }).releases.get({ query: {
        actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } }));
      return pageOf(read, asRelease);
    },

    async copies(work, cursor) {
      const read = await call(() => main().v1.works({ id: uuid(work) }).copies.get({ query: {
        actingSubject, limit: 20, ...(cursor ? { cursor } : {}) } }));
      return pageOf(read, asCopy);
    },

    async createCopy(draft) {
      const written = await call(() => main().v1.me['library-copies'].post({ actingSubject, expectedVersion: 0,
        release: draft.release, format: draft.format, acquiredFrom: draft.acquiredFrom, acquiredAt: draft.acquiredAt,
        ownedFrom: draft.ownedFrom, ownedThrough: null }, headers()));
      return one(written, asCopy);
    },

    async loans(query = {}) {
      const read = await call(() => main().v1.me['library-loans'].get({ query: { actingSubject, limit: 20,
        ...(query.state ? { state: query.state } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) } }));
      return pageOf(read, asLoan);
    },

    async openLoan(draft) {
      const written = await call(() => main().v1.me['library-loans'].post({ actingSubject, expectedVersion: 0,
        copy: draft.copy, direction: draft.direction, counterparty: draft.counterparty, startedAt: draft.startedAt,
        dueAt: draft.dueAt }, headers()));
      return one(written, asLoan);
    },

    async extendLoan(id, expectedVersion, dueAt) {
      const written = await call(() => main().v1.me['library-loans']({ id: uuid(id) }).extend.post({
        actingSubject, expectedVersion, dueAt }, headers()));
      return one(written, asLoan);
    },

    async returnLoan(id, expectedVersion) {
      const written = await call(() => main().v1.me['library-loans']({ id: uuid(id) }).return.post({
        actingSubject, expectedVersion }, headers()));
      return one(written, asLoan);
    },

    async findLoan(id) {
      // A 409 recovery has only the loan id. Walk every page; the first page is not the whole list.
      const search = async (state: 'active' | 'returned'): Promise<RecordResult<LoanRecord | null>> => {
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < LOAN_SEARCH_PAGES; page++) {
          const read = await api.loans({ state, ...(cursor ? { cursor } : {}) });
          if (!read.ok) return read;
          const found = read.data.items.find(loan => loan.id === id);
          if (found) return { ok: true, data: found };
          if (!read.data.nextCursor || seen.has(read.data.nextCursor)) return { ok: true, data: null };
          seen.add(read.data.nextCursor);
          cursor = read.data.nextCursor;
        }
        return { ok: true, data: null };
      };
      const active = await search('active');
      if (!active.ok || active.data) return active;
      return search('returned');
    },

    async person(handle) {
      const read = await call(() => main().v1.handles({ handle }).get({ query: { actingSubject } }));
      if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
      const profile = read.data;
      if (!profile || typeof profile !== 'object' || !('id' in profile) || typeof profile.id !== 'string'
        || !('displayName' in profile) || typeof profile.displayName !== 'string'
        || !('kind' in profile) || typeof profile.kind !== 'string') return { ok: false, failure: 'unavailable' };
      const named = profile as { id: string; displayName: string; handle?: string | null; kind: string };
      return { ok: true, data: { id: named.id, displayName: named.displayName,
        handle: typeof named.handle === 'string' ? named.handle : null, kind: named.kind } };
    },
  };
  return api;
}
