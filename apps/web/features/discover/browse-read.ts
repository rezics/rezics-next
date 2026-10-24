import { BrowseReadError } from './api.ts';
import { failureOf, problemCode, type ReadFailure, type ReadProblem } from './types.ts';
import type { ListPage } from './api.ts';

export type BrowseResult<T> = { ok: true; data: T }
  | ({ ok: false; moved: boolean; pending?: boolean; failure?: ReadFailure } & ReadProblem);

/** Preserve the compact response and every supplied HTTP problem field. */
export async function readBrowse<T>(call: () => Promise<T>): Promise<BrowseResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    return { ok: false, moved: error instanceof BrowseReadError && error.status === 409,
      ...(error instanceof BrowseReadError ? { status: error.status, problem: error.problem,
        failure: failureOf(error.status, error.code ?? undefined),
        ...(error.status === 202 ? { pending: true } : {}) } : {}) };
  }
}

/** Presentation classification belongs to consumers, without changing the compact read protocol. */
export function browseReadFailure(read: Extract<BrowseResult<unknown>, { ok: false }>): ReadFailure {
  return read.failure ?? (read.status !== undefined ? failureOf(read.status, problemCode(read.problem))
    : read.pending ? 'pending' : read.moved ? 'moved' : 'unavailable');
}

/** A request can advance through four empty candidate windows; the owner cursor remains opaque. */
export const BROWSE_SCAN_PAGES = 4;
export async function readBrowseScan<T>(read: (cursor: string | null) => Promise<BrowseResult<ListPage<T>>>,
  cursor: string | null): Promise<{ result: BrowseResult<ListPage<T>>; checkedPages: number }> {
  let result = await read(cursor), checkedPages = 1;
  const seen = new Set(cursor ? [cursor] : []);
  while (result.ok && !result.data.complete) {
    const continuation = result.data.nextCursor;
    // Validate the returned cursor even when a match or the action budget stops this scan.
    if (!continuation || seen.has(continuation)) {
      return { result: { ok: false, moved: false, failure: 'unavailable' }, checkedPages };
    }
    if (result.data.items.length || !(checkedPages < BROWSE_SCAN_PAGES)) break;
    seen.add(continuation);
    result = await read(continuation);
    checkedPages += 1;
  }
  if (!result.ok) return { result: { ...result, failure: browseReadFailure(result) }, checkedPages };
  return { result, checkedPages };
}
