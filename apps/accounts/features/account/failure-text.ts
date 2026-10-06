import type { FailureKind } from '../api/errors.ts';
import type { refusalMessages } from '../api/refusal-messages.ts';

/** Every typed refusal has an explanation and a next step. Only outages use the service-unavailable message. */
export const failureKeys = {
  'invalid-credentials': 'refusalCredentials', 'email-not-verified': 'refusalVerification',
  'rate-limited': 'refusalRate', 'not-enabled': 'refusalDisabled',
  'password-too-short': 'refusalShort', 'password-too-long': 'refusalLong',
  'invalid-token': 'refusalToken', 'expired-request': 'refusalRequestExpired',
  unauthenticated: 'refusalSignedOut', stale: 'refusalStale', conflict: 'refusalConflict',
  unavailable: 'unavailableBody', failed: 'refusalFailed', 'step-up-required': 'refusalStepUp',
  'last-method': 'refusalLastMethod', 'invalid-code': 'refusalCode', cancelled: 'refusalCancelled',
  'minimum-age-confirmation-required': 'refusalMinimumAge', 'invalid-birth-date': 'refusalBirthDate',
  'birth-date-required': 'refusalBirthRequired', 'age-ineligible': 'refusalAge',
  'market-restricted': 'refusalMarketRestricted', 'market-unavailable': 'refusalMarketUnavailable',
  'policy-acceptance-required': 'refusalPolicy', denied: 'refusalDenied',
  'invalid-request': 'refusalInvalidRequest', 'not-found': 'refusalNotFound',
  'account-suspended': 'refusalSuspended', 'password-reset-required': 'refusalResetRequired',
  'account-unavailable': 'refusalAccountBlocked',
  'guardian-duty': 'refusalConflict',
} as const satisfies Record<FailureKind, keyof typeof refusalMessages.en | 'unavailableBody'>;

type CommonText = typeof refusalMessages.en & { unavailableBody: string };
export function failureText(kind: FailureKind, common: CommonText): string {
  return common[failureKeys[kind]];
}
