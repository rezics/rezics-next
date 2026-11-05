import type { OriginalLifecycleResult, WorkflowFence, WorkflowResponsibility } from '@rezics/auth-contract';

/** Literal source results, before their last native reader retires. These are
 * never reconstructed from current state or from the minimized proof skeleton. */
export type RegistrationExpiryResult = {
  outcome: 'expired';
  sourceResult: WorkflowFence;
  handleResult: { accountId: string; handle: string };
  responsibilityResult?: { retired: WorkflowResponsibility; released: WorkflowResponsibility };
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Validate the original port's native provenance, never the consumer's commit.
 * Source routing and original receipt/floor equality remain the reader's job. */
export function originalLifecycleOutcome(result: OriginalLifecycleResult): boolean {
  const outcome = result.outcome;
  return (
    object(outcome) &&
    Object.keys(outcome).length === 5 &&
    Number.isInteger(outcome.partition) &&
    outcome.partition >= 0 &&
    outcome.partition < 4096 &&
    Number.isSafeInteger(outcome.epoch) &&
    outcome.epoch > 0 &&
    typeof outcome.position === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(outcome.position) &&
    BigInt(outcome.position) <= 9223372036854775807n &&
    typeof outcome.transactionId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(outcome.transactionId) &&
    object(outcome.value) &&
    Object.keys(outcome.value).length === (result.kind === 'activation' ? 1 : 3)
  );
}
export function registrationActivationResult(value: unknown): value is { accountId: string } {
  return object(value) && Object.keys(value).length === 1 && typeof value.accountId === 'string' && !!value.accountId;
}
function responsibility(value: unknown, expected: WorkflowResponsibility): value is WorkflowResponsibility {
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.operatorAccountId === expected.operatorAccountId &&
    value.subjectAccountId === expected.subjectAccountId &&
    value.reservationId === expected.reservationId
  );
}

/** Validation follows actual expire/release return contracts. An unavailable or
 * unknown return keeps the original witness pending, even if the command may
 * have committed. Retrying its original key is the only way forward. */
export function registrationExpiryResult(
  claim: { accountId: string; handle: string },
  sourceResult: unknown,
  handleResult: unknown,
  expectedResponsibility?: WorkflowResponsibility,
  responsibilityResult?: { retired: unknown; released: unknown },
): RegistrationExpiryResult | null {
  if (
    !object(sourceResult) ||
    Object.keys(sourceResult).length !== 5 ||
    sourceResult.accountId !== claim.accountId ||
    typeof sourceResult.receiptId !== 'string' ||
    !sourceResult.receiptId ||
    typeof sourceResult.minimumAuthnEpoch !== 'string' ||
    !/^[1-9][0-9]*$/.test(sourceResult.minimumAuthnEpoch) ||
    sourceResult.kind !== 'tombstone' ||
    !(sourceResult.priorOperatorAccountId === null || typeof sourceResult.priorOperatorAccountId === 'string') ||
    !object(handleResult) ||
    Object.keys(handleResult).length !== 2 ||
    handleResult.accountId !== claim.accountId ||
    handleResult.handle !== claim.handle
  )
    return null;
  const result: RegistrationExpiryResult = {
    outcome: 'expired',
    sourceResult: {
      accountId: claim.accountId,
      receiptId: sourceResult.receiptId,
      minimumAuthnEpoch: sourceResult.minimumAuthnEpoch,
      kind: sourceResult.kind,
      priorOperatorAccountId: sourceResult.priorOperatorAccountId,
    },
    handleResult: { accountId: claim.accountId, handle: claim.handle },
  };
  if (expectedResponsibility) {
    if (
      !responsibilityResult ||
      !responsibility(responsibilityResult.retired, expectedResponsibility) ||
      !responsibility(responsibilityResult.released, expectedResponsibility)
    )
      return null;
    result.responsibilityResult = {
      retired: responsibilityResult.retired,
      released: responsibilityResult.released,
    };
  } else if (responsibilityResult) return null;
  return result;
}
