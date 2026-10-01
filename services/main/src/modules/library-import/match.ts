import type { ReaderLibraryImportStore } from './reader-import.ts';
import { ReaderImportUnavailable } from './reader-import.ts';
import { FILE_IMPORT_COST, type CanonicalRow } from './formats/contract.ts';
import type { ImportCandidate, RowMatch } from './file-store.ts';

const fold = (v: string) => v.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
export function chooseCandidates(row: CanonicalRow, candidates: ImportCandidate[], truncated = false): RowMatch {
  const distinct = [...new Map(candidates.map(c => [c.work,c])).values()];
  const exact = distinct.filter(c => fold(c.title) === fold(row.title)
    && (!row.creators.length || c.creators.some(a => row.creators.some(b => fold(a) === fold(b)))));
  const choices = exact.length ? exact : distinct.filter(c => fold(c.title) === fold(row.title));
  const matched = exact.length === 1 && !truncated;
  return { kind: matched ? 'matched' : choices.length || truncated ? 'ambiguous' : 'not-found',
    work: matched ? exact[0]!.work : null, target: matched ? exact[0]!.target : null,
    candidates: choices, truncated, openLibrary: [],openLibraryAvailability: 'not-requested' };
}
export function mainCall(store: ReaderLibraryImportStore, request: Request, method: string,
  path: string, body?: object, key?: string) {
  return store.call(new Request(`http://main.local${path}`, { method,
    headers: { authorization: request.headers.get('authorization') ?? '',
      ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
}
async function read<T>(store: ReaderLibraryImportStore, request: Request, path: string): Promise<T> {
  const response = await mainCall(store,request,'GET',path);
  if (!response.ok) throw new ReaderImportUnavailable('Catalogue matching is unavailable; retry this page');
  return response.json() as Promise<T>;
}
export async function matchLibraryRow(store: ReaderLibraryImportStore, request: Request, agent: string,
  row: CanonicalRow, searchSource: (query: { actingSubject: string; isbn?: string; title?: string; author?: string }) => Promise<Response>): Promise<RowMatch> {
  const owner = `actingSubject=${encodeURIComponent(agent)}`;
  const native = row.work ?? row.session?.target;
  if (row.kind === 'retained' || row.kind === 'shelf') return { kind: 'matched', work: row.work, target: row.target,
    candidates: [], truncated: false, openLibrary: [],openLibraryAvailability: 'not-requested' };
  if (native) {
    const response = await mainCall(store,request,'GET',`/v1/works/${(row.work ?? native).slice(-36)}?${owner}`);
    if (response.status >= 500) throw new ReaderImportUnavailable('Catalogue matching is unavailable');
    return { kind: response.ok ? 'matched' : 'not-found', work: response.ok ? row.work ?? native : null,
      target: row.target, candidates: [], truncated: false, openLibrary: [],openLibraryAvailability: 'not-requested' };
  }
  for (const identifier of row.identifiers.filter(i => i.provider === 'isbn13' || i.provider === 'https://vndb.org/vn')) {
    const query = new URLSearchParams({ actingSubject: agent, limit: '20', ...(identifier.provider === 'isbn13'
      ? { isbn13: identifier.value } : { provider: identifier.provider, identifier: identifier.value }) });
    const page = await read<{ items: Array<{ id: string; title: { value: string }; coverage: Array<{ work: string }> }>; nextCursor: string | null }>(
      store,request,`/v1/releases?${query}`);
    const candidates = page.items.flatMap(r => r.coverage.map(c => ({ work: c.work, target: r.id,
      title: row.title, creators: row.creators })));
    const distinct = [...new Map(candidates.map(c => [c.work,c])).values()];
    // A VN identifier identifies the Work, never an arbitrary first release.
    // Even ISBN evidence with several native releases does not choose a grain.
    const exactTarget = identifier.provider === 'isbn13' && new Set(candidates.map(c => c.target)).size === 1
      ? candidates[0]?.target ?? null : null;
    if (distinct.length) return { kind: distinct.length === 1 && !page.nextCursor ? 'matched' : 'ambiguous',
      work: distinct.length === 1 && !page.nextCursor ? distinct[0]!.work : null,
      target: distinct.length === 1 && !page.nextCursor ? exactTarget : null,
      candidates: distinct, truncated: !!page.nextCursor, openLibrary: [],openLibraryAvailability: 'not-requested' };
  }
  const titleQuery = row.title.replace(/\s+/gu,' ').trim();
  if (titleQuery) {
    // Ranked catalogue retrieval searches selected article bodies. The public
    // title/credit operation supplies title-only Works too, as the existing
    // reader import does. An incomplete title window stays ambiguous.
    const page = await read<{ items: Array<{ work: string; title: { value: string } | null;
      authors: Array<{ displayName: string | null }>; matchedField: 'title' | 'credit'; matchedText: string }>; hasMore: boolean }>(
      store,request,`/v1/search/typeahead?prefix=${encodeURIComponent(titleQuery.slice(0,80))}`);
    const titles = chooseCandidates(row,page.items.map(c => ({ work: c.work,target: null,
      title: c.matchedField === 'title' ? c.matchedText : c.title?.value ?? '',
      creators: c.authors.flatMap(a => a.displayName ? [a.displayName] : []) })),page.hasMore);
    if (titles.kind !== 'not-found') return titles;
  }
  const candidates: ImportCandidate[] = [];
  let cursor: string | null = null;
  for (let index = 0; titleQuery.length >= 2 && index < FILE_IMPORT_COST.searchPages; index++) {
    const query = new URLSearchParams({ q: titleQuery.slice(0,80), limit: '20', ...(cursor ? { cursor } : {}) });
    const page = await read<{ results: Array<{ work: string; title?: { value: string }; primaryCredits?: Array<{ displayName: string }> }>; next: string | null }>(
      store,request,`/v1/search/catalogue?${query}`);
    candidates.push(...page.results.map(c => ({ work: c.work, target: null, title: c.title?.value ?? '',
      creators: c.primaryCredits?.map(a => a.displayName) ?? [] })));
    cursor = page.next; if (!cursor) break;
  }
  const match = chooseCandidates(row,candidates,!!cursor);
  if (match.kind === 'not-found' && titleQuery && !row.identifiers.some(i => i.provider === 'https://vndb.org/vn')) {
    const isbn = row.identifiers.find(i => i.provider === 'isbn13')?.value;
    const queries: { actingSubject: string; isbn?: string; title?: string; author?: string }[] = [...(isbn ? [{ actingSubject: agent,isbn }] : []),{ actingSubject: agent,title: row.title.slice(0,200),
      ...(row.creators[0] ? { author: row.creators[0].slice(0,200) } : {}) }];
    for (const search of queries) {
      const response = await searchSource(search);
      match.openLibraryAvailability = response.ok ? 'available' : response.status === 429 ? 'budget-exceeded' : 'unavailable';
      if (response.ok) match.openLibrary = (await response.json() as { items: RowMatch['openLibrary'] }).items;
      if (!response.ok || match.openLibrary.length) break;
    }
    // Source availability/budgets do not turn an unresolved row into a native match.
  }
  return match;
}
