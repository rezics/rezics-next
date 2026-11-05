/** Public registration echo. Native Access derives a routed UUID; historical
 * callback hosts may use opaque nonempty IDs, bounded here in UTF-16 units.
 */
export const REGISTRATION_ACCOUNT_ID_MAX_LENGTH = 128;
export type RegistrationAcknowledgement = { accountId: string };
export type RegistrationError = 'registration_denied' | 'handle_unavailable';
// {"accountId":""}: 16 ASCII bytes, plus at most six per UTF-16 unit.
export const REGISTRATION_ACK_MAX_BYTES = 16 + 6 * REGISTRATION_ACCOUNT_ID_MAX_LENGTH;
// Closed native JSON envelopes, including punctuation (no diagnostic fields).
export const REGISTRATION_ERROR_MAX_BYTES = 31;
export function registrationAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= REGISTRATION_ACCOUNT_ID_MAX_LENGTH;
}
export function registrationAcknowledgement(value: unknown): value is RegistrationAcknowledgement {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'accountId' in value &&
    registrationAccountId(value.accountId)
  );
}
export function registrationError(value: unknown): value is { error: RegistrationError } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'error' in value &&
    (value.error === 'registration_denied' || value.error === 'handle_unavailable')
  );
}
