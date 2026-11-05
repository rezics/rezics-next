/** Browser projections of native account-operation approval and workflow results.
 * Access seals an ASCII base64url body and SHA-256 MAC; both native unseal and
 * execute's text input cap the reference at 4096 units. No UUID assumption.
 */
export const ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH = 4096;
export const RENAME_EXECUTION_MAX_ID_LENGTH = 4096;
export type RenameApprovalResponse = Readonly<{ reference: string; expiresAt: string }>;
export type RenameExecutionResponse = Readonly<{ accountId: string }>;
export type RenameOperationRefusal = Readonly<{
  error: 'account_operation_denied' | 'step_up_required';
  effect_status: 'not_applied';
}>;

// Closed ASCII skeletons count every key, quote, colon and comma. ISO dates
// have at most 27 ASCII characters (extended years); opaque IDs can escape to
// six UTF-8 bytes per UTF-16 unit, including lone surrogates.
export const RENAME_APPROVAL_MAX_RESPONSE_BYTES =
  JSON.stringify({ reference: '', expiresAt: '' }).length + ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH + 27;
export const RENAME_EXECUTION_MAX_RESPONSE_BYTES =
  JSON.stringify({ accountId: '' }).length + 6 * RENAME_EXECUTION_MAX_ID_LENGTH;
export const ACCOUNT_OPERATION_MAX_ERROR_BYTES = Math.max(
  JSON.stringify({ error: 'account_operation_denied', effect_status: 'not_applied' }).length,
  JSON.stringify({ error: 'step_up_required', effect_status: 'not_applied' }).length,
);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseRenameApprovalResponse(value: unknown): RenameApprovalResponse | null {
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
export function parseRenameOperationRefusal(value: unknown, status: number): RenameOperationRefusal | null {
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

// Organization and rename share the actual Access approval and accountId-only
// workflow output. The reference is opaque to the browser, including its payload.
export const ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES = RENAME_APPROVAL_MAX_RESPONSE_BYTES;
export const parseAccountOperationApprovalResponse = parseRenameApprovalResponse;
export const ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES = RENAME_EXECUTION_MAX_RESPONSE_BYTES;
export const parseOrganizationExecutionResponse = parseRenameExecutionResponse;
export type OrganizationOperationError =
  | RenameOperationRefusal
  | Readonly<{ error: 'platform_closed'; effect_status: 'not_applied' }>
  | Readonly<{ error: 'unavailable' }>;

export function parseOrganizationOperationError(value: unknown, status: number): OrganizationOperationError | null {
  const refusal = parseRenameOperationRefusal(value, status);
  if (refusal) return refusal;
  if (!object(value)) return null;
  if (status === 503 && Object.keys(value).join(',') === 'error' && value.error === 'unavailable')
    return { error: 'unavailable' };
  if (
    status === 403 &&
    Object.keys(value).sort().join(',') === 'effect_status,error' &&
    value.error === 'platform_closed' &&
    value.effect_status === 'not_applied'
  )
    return { error: 'platform_closed', effect_status: 'not_applied' };
  return null;
}
