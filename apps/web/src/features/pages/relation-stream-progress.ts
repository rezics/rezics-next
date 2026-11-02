/** Includes the supplied native page; retries do not consume successful requests. */
export const RELATION_TRAVERSAL_LIMIT = 64;

export type RelationProgress = {
  successfulRequests: number;
  cursors: readonly string[];
  stopped?: 'cycle' | 'limit' | undefined;
};

export function relationCursor(body: Record<string, unknown>): string | undefined {
  return typeof body.next === 'string' && body.next ? body.next : undefined;
}

export function startRelationProgress(cursor: string | undefined): RelationProgress {
  return { successfulRequests: 1, cursors: cursor ? [cursor] : [] };
}

/** Remember only issued continuations, bounded by the fixed traversal ceiling. */
export function advanceRelationProgress(progress: RelationProgress, cursor: string | undefined): RelationProgress {
  const successfulRequests = progress.successfulRequests + 1;
  if (!cursor) return { ...progress, successfulRequests };
  const stopped = progress.cursors.includes(cursor)
    ? 'cycle'
    : successfulRequests >= RELATION_TRAVERSAL_LIMIT
      ? 'limit'
      : undefined;
  return {
    successfulRequests,
    cursors: stopped ? progress.cursors : [...progress.cursors, cursor],
    stopped,
  };
}

/** Native refusals and authority failures must not become transport retries. */
export function relationFailureStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return;
  for (const key of ['status', 'statusCode'] as const) {
    const status = (error as Record<string, unknown>)[key];
    if (typeof status === 'number') return status;
  }
  if ('isNotFound' in error && error.isNotFound) return 404;
  // The session BFF uses this error when its current reader no longer matches.
  if ('message' in error && error.message === 'dependency_unavailable') return 503;
  return;
}
