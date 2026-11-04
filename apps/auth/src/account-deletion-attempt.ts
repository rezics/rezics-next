import type { AccountOperationResult } from './account-operations';
import type { PendingAccountOperationStepUp } from './account-operation-step-up';

export type AccountDeletionPhase = 'review' | 'approval' | 'execution' | 'unknown' | 'committed';
export type AccountDeletionFailure = Extract<AccountOperationResult, { ok: false }>['reason'];

export type AccountDeletionAttempt = {
  readonly operation: { kind: 'delete'; accountId: string };
  readonly operationKey: string;
  readonly phase: AccountDeletionPhase;
  readonly runId: number;
  readonly generation: number;
  /** Monotone browser-departure hint; it does not prove native execution or completion. */
  readonly submitted: boolean;
  /** Once true, later refusals cannot resolve the earlier execution. */
  readonly uncertain: boolean;
  /** True when uncertainty is known only from a continuation hint restored after navigation. */
  readonly hintOnly: boolean;
  readonly lastResponse: AccountDeletionFailure | undefined;
};

export function createAccountDeletionAttempt(
  accountId: string,
  operationKey: string,
  submittedHint = false,
): AccountDeletionAttempt {
  const uncertain = submittedHint;
  return {
    operation: { kind: 'delete', accountId },
    operationKey,
    phase: uncertain ? 'unknown' : 'review',
    runId: 0,
    generation: 0,
    submitted: submittedHint,
    uncertain,
    hintOnly: uncertain,
    lastResponse: undefined,
  };
}

export function restoreAccountDeletionAttempt(
  continuation: PendingAccountOperationStepUp,
): AccountDeletionAttempt | null {
  if (continuation.kind !== 'delete' || continuation.operation.kind !== 'delete') return null;
  return createAccountDeletionAttempt(
    continuation.accountId,
    continuation.operationKey,
    continuation.submitted !== false,
  );
}

export function beginAccountDeletionAttempt(
  attempt: AccountDeletionAttempt,
  generation: number,
): AccountDeletionAttempt {
  return {
    ...attempt,
    phase: 'approval',
    runId: attempt.runId + 1,
    generation,
    hintOnly: false,
    lastResponse: undefined,
  };
}

export function markAccountDeletionExecutionDispatched(
  attempt: AccountDeletionAttempt,
  runId: number,
): AccountDeletionAttempt {
  if (attempt.runId !== runId || attempt.phase !== 'approval') return attempt;
  return { ...attempt, phase: 'execution', submitted: true, hintOnly: false };
}

export function finishAccountDeletionAttempt(
  attempt: AccountDeletionAttempt,
  runId: number,
  result: AccountOperationResult,
): AccountDeletionAttempt {
  if (attempt.runId !== runId || (attempt.phase !== 'approval' && attempt.phase !== 'execution')) return attempt;
  if (result.ok && result.accountId === attempt.operation.accountId)
    return { ...attempt, phase: 'committed', uncertain: false, hintOnly: false, lastResponse: undefined };

  if (result.ok)
    return {
      ...attempt,
      phase: 'unknown',
      uncertain: true,
      hintOnly: false,
      lastResponse: 'unknown',
    };

  const uncertain = attempt.uncertain || result.reason === 'unknown';
  return {
    ...attempt,
    phase: uncertain ? 'unknown' : 'review',
    uncertain,
    hintOnly: false,
    lastResponse: result.reason,
  };
}

export function retireAccountDeletionAttempt(attempt: AccountDeletionAttempt): AccountDeletionAttempt {
  if (attempt.phase === 'committed' || attempt.phase === 'unknown') return attempt;
  if (attempt.phase === 'execution')
    return { ...attempt, phase: 'unknown', uncertain: true, hintOnly: false, lastResponse: 'unknown' };
  if (attempt.phase === 'approval') return { ...attempt, phase: attempt.uncertain ? 'unknown' : 'review' };
  return attempt;
}

export function accountDeletionAttemptMatches(
  attempt: AccountDeletionAttempt | null,
  accountId: string,
  operationKey: string,
): attempt is AccountDeletionAttempt {
  return Boolean(
    attempt &&
      attempt.operation.kind === 'delete' &&
      attempt.operation.accountId === accountId &&
      attempt.operationKey === operationKey,
  );
}

export function accountDeletionAttemptMayHaveCommitted(attempt: AccountDeletionAttempt | null): boolean {
  return Boolean(attempt?.uncertain || attempt?.phase === 'execution');
}
