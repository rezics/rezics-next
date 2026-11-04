import { ProblemError } from '../http/problem.ts';

type ShelfPage = {
  entries: readonly unknown[];
  next: unknown;
  scoreQuestion?: unknown;
};

/** Preserve the first cursor while requiring its ordered rows and lookahead to remain admitted. */
export function assertShelfPageCurrent(observed: ShelfPage, current: unknown): asserts current is ShelfPage {
  if (typeof current !== 'object' || current === null || !('entries' in current) || !Array.isArray(current.entries))
    throw new ProblemError('semantic_not_ready');
  const page = current as ShelfPage;
  if (
    JSON.stringify(page.entries) !== JSON.stringify(observed.entries) ||
    Boolean(page.next) !== Boolean(observed.next) ||
    JSON.stringify(page.scoreQuestion ?? null) !== JSON.stringify(observed.scoreQuestion ?? null)
  )
    throw new ProblemError('semantic_not_ready');
}
