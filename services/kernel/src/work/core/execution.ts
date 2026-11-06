import { WORK_EXECUTION_ATTEMPT_BOUND } from '../contract/index.ts';

export type WorkExecutionSnapshot = Readonly<{
  deadline: number;
  claimed: boolean;
  attempts: number;
}>;

export function executionDeadlineLive(deadline: number, now: number): boolean {
  return Number.isFinite(deadline) && now < deadline;
}

export function assertOpenExecution(deadline: number, now: number): void {
  if (!executionDeadlineLive(deadline, now)) throw new Error('work-execution-deadline');
}

export function nextExecutionAttempt(attempts: number): number {
  const next = attempts + 1;
  if (next > WORK_EXECUTION_ATTEMPT_BOUND) throw new Error('work-execution-attempt-bound');
  return next;
}

export function selectedContinuationInput(
  locator: Readonly<{ ownerAccountId: string; route: number; collectionId: string; episodeId: string }>,
): string {
  return JSON.stringify({
    accounts: [locator.ownerAccountId],
    route: locator.route,
    episodes: [{ collectionId: locator.collectionId, episodeId: locator.episodeId }],
    cleanup: [],
  });
}
