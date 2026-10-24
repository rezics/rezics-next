import type { GateOutcome } from './contracts.ts';
import type { Attempt, AttemptRecord, FailureClass, Task } from './types.ts';
import type { Route } from './routing.ts';
import { matchesPath } from './briefs.ts';

/** Gate producers may use SPEC_CONFLICT in the first assertion for a machine-proven contract conflict. */
export function classifyFailure(outcome: GateOutcome, task: Task, attempt: Attempt, record: AttemptRecord, limits: Route, hasCommit: boolean): FailureClass {
  if (outcome.stage === 'setup' || outcome.failsOnMain || outcome.timedOut) return 'environment';
  if (/\b(quota|usage_limit|rate_limit|allowance)[-_ ]?(exhausted|reached|exceeded)\b/i.test(outcome.firstFailure?.fingerprint ?? '')
    || /\b(usage limit|quota exhausted|rate limit reached)\b/i.test(attempt.result)) return 'pool-exhausted';
  if (attempt.exitCode !== null && attempt.exitCode !== 0) return 'environment';
  if (/^SPEC_CONFLICT\b/.test(outcome.firstFailure?.assertion ?? '')) return 'spec-conflict';
  if (outcome.stage === 'scope' || outcome.changedFiles.some(path => !matchesPath(path, task.brief.paths))
    || outcome.diffLines > task.brief.estimate.lines || outcome.changedFiles.length > task.brief.estimate.files) return 'scope-growth';
  if (!hasCommit && (record.steps > limits.maxSteps || Date.parse(record.endedAt) - Date.parse(record.startedAt) > limits.maxMs)) return 'stalled';
  if (attempt.fixRound >= 2) return 'round-limit';
  if (attempt.consulted) return 'failed-after-consult';
  if (outcome.firstFailure && outcome.firstFailure.fingerprint === attempt.previousFailure) return 'repeated-assertion';
  if (!attempt.blocker || /\bRESULT:\s*success\b/i.test(attempt.result)) return 'early-stop';
  return 'new-failure';
}
