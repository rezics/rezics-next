import { BrowseReadError } from './api.ts';
import { failureOf, type ReadFailure, type ReadProblem } from './types.ts';
import type { ListPage } from './api.ts';

export type BrowseResult<T> = { ok: true; data: T }
  | ({ ok: false; moved: boolean; pending?: boolean; failure?: ReadFailure } & ReadProblem);

/** Keep HTTP evidence when a list chooses a compact presentation category. */
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

/** A request can advance through four empty candidate windows; the owner cursor remains opaque. */
export const BROWSE_SCAN_PAGES = 4;
export async function readBrowseScan<T>(read: (cursor: string | null) => Promise<BrowseResult<ListPage<T>>>,
  cursor: string | null): Promise<{ result: BrowseResult<ListPage<T>>; checkedPages: number }> {
  let result = await read(cursor), checkedPages = 1;
  const seen = new Set(cursor ? [cursor] : []);
  while (result.ok && !result.data.complete && !result.data.items.length && checkedPages < BROWSE_SCAN_PAGES) {
    const continuation = result.data.nextCursor;
    if (!continuation || seen.has(continuation)) return { result: { ok: false, moved: false }, checkedPages };
    seen.add(continuation);
    result = await read(continuation);
    checkedPages += 1;
  }
  return { result, checkedPages };
}
