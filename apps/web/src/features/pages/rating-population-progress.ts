/** The first page counts; failed attempts keep their exact request and consume no reads. */
export const POPULATION_TRAVERSAL_LIMIT = 64;

export type PopulationPageRequest = { cursor: string | undefined; revision: number };
export type PopulationProgress = {
  request: PopulationPageRequest;
  accepted?: PopulationPageRequest | undefined;
  successfulReads: number;
  cursors: readonly string[];
  stopped?: 'cycle' | 'limit' | undefined;
};

export function startPopulationProgress(revision = 0, accepted?: PopulationPageRequest): PopulationProgress {
  return { request: { cursor: undefined, revision }, accepted, successfulReads: 0, cursors: [] };
}

export function populationRequestKey(request: PopulationPageRequest): string {
  return JSON.stringify([request.revision, request.cursor]);
}

/** Keep identities of issued pages, never rows or an unbounded query history. */
export function acceptPopulationPage(
  progress: PopulationProgress,
  request: PopulationPageRequest,
  next: string | null,
): PopulationProgress {
  if (progress.stopped) return progress;
  const active = request.revision === progress.request.revision;
  // A retained page may be revalidated, but a page from an old traversal cannot advance this one.
  if (!active && (request.revision !== progress.accepted?.revision || progress.successfulReads === 0)) return progress;
  const successfulReads = progress.successfulReads + 1;
  const cursors =
    request.cursor !== undefined && !progress.cursors.includes(request.cursor)
      ? [...progress.cursors, request.cursor]
      : progress.cursors;
  const stopped =
    next !== null && cursors.includes(next)
      ? 'cycle'
      : successfulReads >= POPULATION_TRAVERSAL_LIMIT
        ? 'limit'
        : undefined;
  return {
    ...progress,
    accepted: active ? request : progress.accepted,
    successfulReads,
    cursors,
    stopped,
  };
}

export function nextPopulationPage(progress: PopulationProgress, next: string | null): PopulationProgress {
  if (
    progress.stopped ||
    next === null ||
    progress.request.revision !== progress.accepted?.revision ||
    progress.cursors.includes(next)
  )
    return progress;
  return { ...progress, request: { cursor: next, revision: progress.request.revision + 1 } };
}

export function restartPopulationProgress(progress: PopulationProgress): PopulationProgress {
  return startPopulationProgress(progress.request.revision + 1, progress.accepted);
}
