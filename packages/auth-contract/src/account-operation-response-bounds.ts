/** Browser projections of native account-operation approval and deletion/rename results.
 * Access seals an ASCII base64url body and SHA-256 MAC; both native unseal and
 * execute's text input cap the reference at 4096 units. No UUID assumption.
 */
export const ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH = 4096;
export const RENAME_EXECUTION_MAX_ID_LENGTH = 4096;
export type AccountOperationApprovalResponse = Readonly<{ reference: string; expiresAt: string }>;
export type RenameApprovalResponse = AccountOperationApprovalResponse;
export type AccountOperationRefusal = Readonly<{
  error: 'account_operation_denied' | 'step_up_required';
  effect_status: 'not_applied';
}>;
export type RenameExecutionResponse = Readonly<{ accountId: string }>;
export type RenameOperationRefusal = AccountOperationRefusal;

// Closed ASCII skeletons count every key, quote, colon and comma. ISO dates
// have at most 27 ASCII characters (extended years); opaque IDs can escape to
// six UTF-8 bytes per UTF-16 unit, including lone surrogates.
export const RENAME_APPROVAL_MAX_RESPONSE_BYTES =
  JSON.stringify({ reference: '', expiresAt: '' }).length + ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH + 27;
export const ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES = RENAME_APPROVAL_MAX_RESPONSE_BYTES;
export const RENAME_EXECUTION_MAX_RESPONSE_BYTES =
  JSON.stringify({ accountId: '' }).length + 6 * RENAME_EXECUTION_MAX_ID_LENGTH;
export const ACCOUNT_OPERATION_MAX_ERROR_BYTES = Math.max(
  JSON.stringify({ error: 'account_operation_denied', effect_status: 'not_applied' }).length,
  JSON.stringify({ error: 'step_up_required', effect_status: 'not_applied' }).length,
);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseAccountOperationApprovalResponse(value: unknown): AccountOperationApprovalResponse | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'expiresAt,reference' ||
    typeof value.reference !== 'string' ||
    value.reference.length > ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH ||
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.exec(value.reference)?.[0] !== value.reference ||
    typeof value.expiresAt !== 'string' ||
    value.expiresAt.length > 27 ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    return null;
  return { reference: value.reference, expiresAt: value.expiresAt };
}
export function isAccountOperationReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.exec(value)?.[0] === value
  );
}
export function parseRenameExecutionResponse(value: unknown): RenameExecutionResponse | null {
  if (
    !object(value) ||
    Object.keys(value).join(',') !== 'accountId' ||
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    value.accountId.length > RENAME_EXECUTION_MAX_ID_LENGTH
  )
    return null;
  return { accountId: value.accountId };
}
export function parseAccountOperationRefusal(value: unknown, status: number): AccountOperationRefusal | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'effect_status,error' ||
    value.effect_status !== 'not_applied'
  )
    return null;
  if (value.error === 'step_up_required' && status === 401) return { error: value.error, effect_status: 'not_applied' };
  if (value.error === 'account_operation_denied' && [400, 401, 403, 409, 413, 415, 503].includes(status))
    return { error: value.error, effect_status: 'not_applied' };
  return null;
}
export const parseRenameOperationRefusal = parseAccountOperationRefusal;

// Deletion accepts legal JSON escaping of the sealed ASCII reference as well.
export const DELETION_APPROVAL_MAX_RESPONSE_BYTES =
  JSON.stringify({ reference: '', expiresAt: '' }).length + 6 * ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH + 27;
export const DELETION_EXECUTION_MAX_RESPONSE_BYTES = RENAME_EXECUTION_MAX_RESPONSE_BYTES;
export const parseRenameApprovalResponse = parseAccountOperationApprovalResponse;
export const parseDeletionExecutionResponse = parseRenameExecutionResponse;
export const parseDeletionOperationRefusal = parseRenameOperationRefusal;
