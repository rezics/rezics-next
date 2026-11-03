import { defaultPolicy } from './policy.ts';
import type { GateOutcome } from './contracts.ts';
import type { Attempt, AttemptRecord, FailureClass, Task } from './types.ts';
import type { Route } from './routing.ts';
import { devProductBrief, matchesPath } from './briefs.ts';

/** An estimate is a rough size; only a diff beyond this multiple of it counts as scope growth. */
export const ESTIMATE_TOLERANCE = 2;

/** The diff size counted against the brief's estimate: declared paths only for product work on dev. */
function estimatedSize(
  outcome: GateOutcome,
  task: Task,
  policy = defaultPolicy.brief,
): { lines: number; files: number } {
  const devProduct = devProductBrief(task.brief);
  return {
    lines: outcome.nonGeneratedDiffLines ?? outcome.diffLines,
    files: (outcome.nonGeneratedChangedFiles ?? outcome.changedFiles).filter(
      (path) => !devProduct || matchesPath(path, task.brief.paths, policy),
    ).length,
  };
}

/**
 * How far a diff exceeds its brief's estimate beyond the tolerance; undefined within it. Product work on dev records
 * this on its attempt instead of stopping: the estimate sizes the work, it does not fence it.
 */
export function estimateOverrun(
  outcome: GateOutcome,
  task: Task,
  policy = defaultPolicy.brief,
): { lines: number; files: number; estimate: { lines: number; files: number } } | undefined {
  const size = estimatedSize(outcome, task, policy);
  const { estimate } = task.brief;
  if (size.lines <= ESTIMATE_TOLERANCE * estimate.lines && size.files <= ESTIMATE_TOLERANCE * estimate.files)
    return undefined;
  return { ...size, estimate: { lines: estimate.lines, files: estimate.files } };
}

/** Gate evidence stays separate from structured launch and worker-exit facts. */
export function classifyFailure(
  outcome: GateOutcome,
  task: Task,
  attempt: Attempt,
  record: AttemptRecord,
  limits: Route,
  hasCommit: boolean,
  policy = defaultPolicy.brief,
): FailureClass {
  if (
    attempt.failureKind === 'spec-conflict' ||
    attempt.failureKind === 'scope-growth' ||
    attempt.failureKind === 'pool-exhausted'
  )
    return attempt.failureKind;
  if (attempt.failureKind === 'tool' || outcome.stage === 'setup' || outcome.failsOnMain || outcome.timedOut)
    return 'environment';
  if (attempt.exitCode !== null && attempt.exitCode !== 0) return 'environment';
  // Product work on the integration branch may change files outside its declared paths and grow past its estimate:
  // the attempt record lists both, and neither stops the task. A scope-stage refusal (an undeclared risk area) still
  // stops every task.
  const devProduct = devProductBrief(task.brief);
  if (
    outcome.stage === 'scope' ||
    (!devProduct &&
      (outcome.changedFiles.some((path) => !matchesPath(path, task.brief.paths, policy)) ||
        estimateOverrun(outcome, task, policy)))
  )
    return 'scope-growth';
  if (
    !hasCommit &&
    (record.steps > limits.maxSteps || Date.parse(record.endedAt) - Date.parse(record.startedAt) > limits.maxMs)
  )
    return 'stalled';
  // Product retries on the integration branch are unlimited and need no approval: a later fix round, or a failure
  // after consultation, continues in the task's branch and session instead of waiting for its manager.
  if (!devProduct && attempt.fixRound >= 2) return 'round-limit';
  if (!devProduct && attempt.consulted) return 'failed-after-consult';
  if (outcome.firstFailure && outcome.firstFailure.fingerprint === attempt.previousFailure) return 'repeated-assertion';
  if (!attempt.blocker || /\bRESULT:\s*success\b/i.test(attempt.result)) return 'early-stop';
  return 'new-failure';
}
