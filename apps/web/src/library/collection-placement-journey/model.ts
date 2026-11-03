/** The Collection list and member routes admit opaque cursors up to this native bound. */
export const COLLECTION_MOVE_CURSOR_MAX_LENGTH = 4_096;

export type BoundedPageVisit = Readonly<{
  cursor: string | undefined;
  previousCursor: string | undefined;
  page: number;
  canGoPrevious: boolean;
}>;

export function firstPageVisit(): BoundedPageVisit {
  return { cursor: undefined, previousCursor: undefined, page: 1, canGoPrevious: false };
}

/** Keep only the cursor used for the current page and one previous-page descriptor. */
export function nextPageVisit(visit: BoundedPageVisit, frontier: string | null): BoundedPageVisit {
  if (!frontier || frontier.length > COLLECTION_MOVE_CURSOR_MAX_LENGTH) throw new Error('Invalid Collection frontier');
  return { cursor: frontier, previousCursor: visit.cursor, page: visit.page + 1, canGoPrevious: true };
}

/** A previous read is one step only; restart explicitly to return to the first page again. */
export function previousPageVisit(visit: BoundedPageVisit): BoundedPageVisit | null {
  if (!visit.canGoPrevious) return null;
  const page = visit.page - 1;
  return page === 1
    ? firstPageVisit()
    : { cursor: visit.previousCursor, previousCursor: undefined, page, canGoPrevious: false };
}

export function moveReadFailure(error: unknown): 'denied' | 'expired' | 'changed' | 'unavailable' {
  const value = error as { message?: unknown; status?: unknown; statusCode?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message : '';
  if (message.includes('stale_cursor')) return 'expired';
  if (message.includes('Move destination changed')) return 'changed';
  if (
    message.includes('Move session unavailable') ||
    value?.status === 401 ||
    value?.status === 403 ||
    value?.status === 404 ||
    value?.statusCode === 401 ||
    value?.statusCode === 403 ||
    value?.statusCode === 404
  )
    return 'denied';
  return 'unavailable';
}
