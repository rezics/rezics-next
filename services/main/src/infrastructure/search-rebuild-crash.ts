/** QA-only stop after a committed rebuild step. Production preflight rejects both names. */

export const SEARCH_REBUILD_CRASH_FLAG = 'REZICS_QA_SEARCH_REBUILD_CRASH';
export const SEARCH_REBUILD_CRASH_AT = 'REZICS_QA_SEARCH_REBUILD_CRASH_AT';
export const SEARCH_REBUILD_CRASH_POINTS = [
  'after-quarantine',
  'after-clear',
  'after-offline-index',
  'after-replay',
  'before-activation',
] as const;
export type SearchRebuildCrashPoint = typeof SEARCH_REBUILD_CRASH_POINTS[number];

export class SearchRebuildCrash extends Error {
  readonly point: SearchRebuildCrashPoint;
  constructor(point: SearchRebuildCrashPoint) {
    super(`search rebuild crash: ${point}`);
    this.point = point;
  }
}

/** Inert unless a test arms the flag outside production and names this point. */
export function crashSearchRebuild(point: SearchRebuildCrashPoint): void {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env[SEARCH_REBUILD_CRASH_FLAG] !== '1') return;
  if (process.env[SEARCH_REBUILD_CRASH_AT] !== point) return;
  throw new SearchRebuildCrash(point);
}
