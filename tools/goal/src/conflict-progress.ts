import type { RebaseConflictContext } from './contracts.ts';

export const REBASE_CONFLICT_HISTORY_LIMIT = 6;
export const REBASE_CONFLICT_PRIOR_MATCHES_TO_STOP = 2;

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type WorkerSourceBaseline = {
  /** Last source HEAD that represented worker-authored progress. */
  workerCommit: string;
  /** Branch HEAD after controller setup, used to identify later worker commits. */
  controllerHead: string;
};

export function completeWorkerSourceBaseline(value: unknown): WorkerSourceBaseline | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { workerCommit?: unknown; controllerHead?: unknown };
  if (
    typeof candidate.workerCommit !== 'string' ||
    typeof candidate.controllerHead !== 'string' ||
    !objectIdPattern.test(candidate.workerCommit) ||
    !objectIdPattern.test(candidate.controllerHead)
  )
    return undefined;
  return { workerCommit: candidate.workerCommit.toLowerCase(), controllerHead: candidate.controllerHead.toLowerCase() };
}

export function canonicalConflictPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Build only a complete context from the values captured at the actual Git conflict. */
export function makeRebaseConflictContext(
  targetHead: string | undefined,
  workerCommit: string | undefined,
  paths: readonly string[],
): RebaseConflictContext | undefined {
  if (!targetHead || !workerCommit || !objectIdPattern.test(targetHead) || !objectIdPattern.test(workerCommit))
    return undefined;
  const canonicalPaths = canonicalConflictPaths(paths);
  if (!canonicalPaths.length) return undefined;
  return {
    targetHead: targetHead.toLowerCase(),
    workerCommit: workerCommit.toLowerCase(),
    paths: canonicalPaths,
  };
}

/** Older durable outcomes and partial records intentionally remain unknown. */
export function completeRebaseConflictContext(value: unknown): RebaseConflictContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { targetHead?: unknown; workerCommit?: unknown; paths?: unknown };
  if (
    typeof candidate.targetHead !== 'string' ||
    typeof candidate.workerCommit !== 'string' ||
    !Array.isArray(candidate.paths) ||
    !candidate.paths.every((path): path is string => typeof path === 'string')
  )
    return undefined;
  return makeRebaseConflictContext(candidate.targetHead, candidate.workerCommit, candidate.paths);
}

export function sameRebaseConflict(left: unknown, right: unknown): boolean {
  const a = completeRebaseConflictContext(left);
  const b = completeRebaseConflictContext(right);
  return Boolean(
    a &&
    b &&
    a.targetHead === b.targetHead &&
    a.workerCommit === b.workerCommit &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, index) => path === b.paths[index]),
  );
}

/** Require two complete matching earlier conflicts among the six most recent prior attempts. */
export function repeatedNoProgressConflict(
  current: unknown,
  priorAttempts: readonly unknown[],
): RebaseConflictContext | undefined {
  const context = completeRebaseConflictContext(current);
  if (!context) return undefined;
  const matchingPrior = priorAttempts
    .slice(-REBASE_CONFLICT_HISTORY_LIMIT)
    .filter((candidate) => sameRebaseConflict(context, candidate)).length;
  return matchingPrior >= REBASE_CONFLICT_PRIOR_MATCHES_TO_STOP ? context : undefined;
}
