import type { FailureKind } from '../api/errors.ts';

type CommonText = { notAvailableYet: string; staleBody: string; unavailableBody: string };

/** The message for a failed account change that has no more specific wording. */
export function failureText(kind: FailureKind, common: CommonText): string {
  return kind === 'not-enabled' ? common.notAvailableYet
    : kind === 'stale' ? common.staleBody : common.unavailableBody;
}
