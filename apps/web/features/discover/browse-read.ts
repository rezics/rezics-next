import { BrowseReadError } from './api.ts';
import type { ReadProblem } from './types.ts';

export type BrowseResult<T> = { ok: true; data: T } | ({ ok: false; moved: boolean; pending?: boolean } & ReadProblem);

/** Keep HTTP evidence when a list chooses a compact presentation category. */
export async function readBrowse<T>(call: () => Promise<T>): Promise<BrowseResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    return { ok: false, moved: error instanceof BrowseReadError && error.status === 409,
      ...(error instanceof BrowseReadError ? { status: error.status, problem: error.problem,
        ...(error.status === 202 ? { pending: true } : {}) } : {}) };
  }
}
