export type SecurityTargetReturnOutcome = 'unknown' | 'acknowledged' | 'refused';

export type SecurityTargetReturnAttempt = { kind: string; outcome?: SecurityTargetReturnOutcome };

export function securityTargetReturnFromAttempt(
  attempt: SecurityTargetReturnAttempt | null,
): SecurityTargetReturnOutcome | null {
  if (attempt?.kind === 'target') return 'unknown';
  return attempt?.kind === 'recovery' ? (attempt.outcome ?? null) : null;
}

/** Keep an earlier unknown outcome until the person dismisses its presentation. */
export function retainSecurityTargetReturn(
  current: SecurityTargetReturnOutcome | null,
  next: SecurityTargetReturnOutcome,
): SecurityTargetReturnOutcome {
  return current === 'unknown' ? current : next;
}
