import type { GateOutcome } from './contracts.ts';
import type { Attempt, AttemptRecord, FailureClass, Task } from './types.ts';
import type { Route } from './routing.ts';
import { matchesPath } from './briefs.ts';

/** An estimate is a rough size; only a diff beyond this multiple of it counts as scope growth. */
export const ESTIMATE_TOLERANCE = 2;

/** Gate evidence stays separate from structured launch and worker-exit facts. */
export function classifyFailure(
  outcome: GateOutcome,
  task: Task,
  attempt: Attempt,
  record: AttemptRecord,
  limits: Route,
  hasCommit: boolean,
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
  if (
    outcome.stage === 'scope' ||
    outcome.changedFiles.some((path) => !matchesPath(path, task.brief.paths)) ||
    (outcome.nonGeneratedDiffLines ?? outcome.diffLines) > ESTIMATE_TOLERANCE * task.brief.estimate.lines ||
    (outcome.nonGeneratedChangedFiles ?? outcome.changedFiles).length > ESTIMATE_TOLERANCE * task.brief.estimate.files
  )
    return 'scope-growth';
  if (
    !hasCommit &&
    (record.steps > limits.maxSteps || Date.parse(record.endedAt) - Date.parse(record.startedAt) > limits.maxMs)
  )
    return 'stalled';
  if (attempt.fixRound >= 2) return 'round-limit';
  if (attempt.consulted) return 'failed-after-consult';
  if (outcome.firstFailure && outcome.firstFailure.fingerprint === attempt.previousFailure) return 'repeated-assertion';
  if (!attempt.blocker || /\bRESULT:\s*success\b/i.test(attempt.result)) return 'early-stop';
  return 'new-failure';
}
