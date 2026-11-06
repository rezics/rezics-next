import { isOperatorPageId, OPERATOR_PAGE_ID_BYTES } from './operator-page-response-bounds';
import { AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH } from './automated-page-response-bounds.ts';

/** Browser projections of native account-operation approval and workflow results.
 * References stay opaque here; native authorization owns their validity, while
 * its producer and consumer both cap them at 4096 UTF-16 units.
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
    !value.reference ||
    value.reference.length > ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH ||
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
export function parseRenameApprovalResponse(value: unknown): RenameApprovalResponse | null {
  const approval = parseAccountOperationApprovalResponse(value);
  return approval && isAccountOperationReference(approval.reference) ? approval : null;
}
export const parseDeletionExecutionResponse = parseRenameExecutionResponse;
export const parseDeletionOperationRefusal = parseRenameOperationRefusal;

/** Membership also supports native locator references, with at most one seal separator.
 * Keep opaque IDs opaque: HTTP command operands admit up to 4096 UTF-16 units.
 */
export const MEMBERSHIP_APPROVAL_MAX_RESPONSE_BYTES =
  JSON.stringify({ reference: '', expiresAt: '' }).length + 6 * (ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH + 27);
export const MEMBERSHIP_EXECUTION_MAX_RESPONSE_BYTES = RENAME_EXECUTION_MAX_RESPONSE_BYTES;
export function parseMembershipApprovalResponse(value: unknown): AccountOperationApprovalResponse | null {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'expiresAt,reference' ||
    typeof value.reference !== 'string' ||
    value.reference.length > ACCOUNT_OPERATION_MAX_REFERENCE_LENGTH ||
    /^[A-Za-z0-9][A-Za-z0-9:_/-]*(?:\.[A-Za-z0-9_-]+)?$/.exec(value.reference)?.[0] !== value.reference ||
    typeof value.expiresAt !== 'string' ||
    value.expiresAt.length > 27 ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    return null;
  return { reference: value.reference, expiresAt: value.expiresAt };
}
export const parseMembershipExecutionResponse = parseRenameExecutionResponse;

/** Browser-safe account-operation responses used by automated account creation.
 * Access seals references with a 4,096-character token ceiling and the execute
 * input admits the same ceiling. Expiry is emitted with Date.toISOString().
 */
export const ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH = 4096;
export const ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH = 24;
export const ACCOUNT_OPERATION_ACCOUNT_ID_MAX_LENGTH = 36;
export const ACCOUNT_OPERATION_KEY_MAX_LENGTH = 128;

export type AccountOperationNotAppliedError = Readonly<{
  error: 'account_operation_denied' | 'platform_closed' | 'step_up_required';
  effect_status: 'not_applied';
}>;

export type AutomatedAccountExecutionAcknowledgement = Readonly<{
  accountId: string;
}>;

/** The native workflow may have completed before an incompatible result or
 * transport exception reaches this endpoint. This envelope deliberately makes
 * no not-applied claim.
 */
export type AutomatedAccountExecutionUnresolved = Readonly<{
  error: 'account_operation_unresolved';
}>;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const escapedStringBytes = (units: number) => units * 6;

const approvalSuccess =
  utf8Bytes(JSON.stringify({ reference: '', expiresAt: '' })) +
  escapedStringBytes(ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH) +
  ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH;
const executionSuccess = utf8Bytes(JSON.stringify({ accountId: '' })) + ACCOUNT_OPERATION_ACCOUNT_ID_MAX_LENGTH;
const automatedExecuteRequest =
  utf8Bytes(
    JSON.stringify({
      operation: {
        kind: 'automated',
        registrationId: '',
        operationKey: '',
        operatorAccountId: '',
        handle: '',
      },
      operationKey: '',
      accountId: '',
      reference: '',
    }),
  ) +
  escapedStringBytes(ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH + 2 * ACCOUNT_OPERATION_KEY_MAX_LENGTH) +
  2 * ACCOUNT_OPERATION_ACCOUNT_ID_MAX_LENGTH +
  AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH;
const notApplied = utf8Bytes(JSON.stringify({ error: 'account_operation_denied', effect_status: 'not_applied' }));
const stepUp = utf8Bytes(JSON.stringify({ error: 'step_up_required', effect_status: 'not_applied' }));
const platformClosed = utf8Bytes(JSON.stringify({ error: 'platform_closed', effect_status: 'not_applied' }));
const unresolved = utf8Bytes(JSON.stringify({ error: 'account_operation_unresolved' }));

/** Exact closed response ceilings, including JSON keys, punctuation and
 * worst-case escaping of every admitted UTF-16 string unit.
 */
export const automatedAccountOperationResponseByteBudgets = Object.freeze({
  approval: Math.max(approvalSuccess, notApplied, platformClosed, stepUp),
  execution: Math.max(executionSuccess, notApplied, platformClosed, stepUp, unresolved),
});

export const automatedAccountOperationRequestByteBudgets = Object.freeze({
  execute: automatedExecuteRequest,
});

// Organization and rename share the actual Access approval and accountId-only
// workflow output. The reference is opaque to the browser, including its payload.
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

/** Access seals a locator and emits Date.toISOString(), including extended years.
 * Opaque locators retain the installed 4,096 UTF-16-unit allowance. */
export const ACCOUNT_OPERATION_REFERENCE_MAX_UNITS = 4096;
export type AccountOperationApproval = { reference: string; expiresAt: string };
const approvalSkeleton = JSON.stringify({ reference: '', expiresAt: '' }).length;
export const TRANSFER_APPROVAL_MAX_RESPONSE_BYTES = approvalSkeleton + 6 * ACCOUNT_OPERATION_REFERENCE_MAX_UNITS + 27;
export const TRANSFER_EXECUTION_MAX_RESPONSE_BYTES = JSON.stringify({ accountId: '' }).length + OPERATOR_PAGE_ID_BYTES;
const deniedStatuses = [400, 401, 403, 409, 413, 415, 503];
export const TRANSFER_MAX_ERROR_BYTES = Math.max(
  ...['account_operation_denied', 'step_up_required', 'platform_closed'].map(
    (error) => JSON.stringify({ error, effect_status: 'not_applied' }).length,
  ),
  JSON.stringify({ error: 'account_operation_unavailable' }).length,
);
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}
export function parseAccountOperationApproval(value: unknown): AccountOperationApproval | null {
  if (
    !object(value) ||
    !keys(value, 'expiresAt,reference') ||
    typeof value.reference !== 'string' ||
    !value.reference.length ||
    value.reference.length > ACCOUNT_OPERATION_REFERENCE_MAX_UNITS ||
    /[\u0000-\u0020\u007f]/.test(value.reference) ||
    typeof value.expiresAt !== 'string' ||
    !/^(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value.expiresAt)
  )
    return null;
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== value.expiresAt) return null;
  return { reference: value.reference, expiresAt: value.expiresAt };
}
/** Native transfer has no receipt, operator, expiry or pending fields. */
export function parseTransferExecution(value: unknown, subjectAccountId: string): { accountId: string } | null {
  return object(value) &&
    keys(value, 'accountId') &&
    isOperatorPageId(value.accountId) &&
    value.accountId === subjectAccountId
    ? { accountId: value.accountId }
    : null;
}
/** Only these exact native pre-effect envelopes establish a known refusal. */
export function parseTransferOperationRefusal(value: unknown, status: number): string | null {
  if (!object(value) || !keys(value, 'effect_status,error') || value.effect_status !== 'not_applied') return null;
  return (value.error === 'account_operation_denied' && deniedStatuses.includes(status)) ||
    (value.error === 'step_up_required' && status === 401) ||
    (value.error === 'platform_closed' && status === 403)
    ? (value.error as string)
    : null;
}
