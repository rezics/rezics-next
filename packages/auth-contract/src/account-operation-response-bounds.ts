import { AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH } from './automated-page-response-bounds.ts';

/** Browser-safe account-operation responses used by automated account creation.
 * Access seals references with a 4,096-character token ceiling and the execute
 * input admits the same ceiling. Expiry is emitted with Date.toISOString().
 */
export const ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH = 4096;
export const ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH = 24;
export const ACCOUNT_OPERATION_ACCOUNT_ID_MAX_LENGTH = 36;
export const ACCOUNT_OPERATION_KEY_MAX_LENGTH = 128;

export type AccountOperationApprovalResponse = Readonly<{
  reference: string;
  expiresAt: string;
}>;

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
const executionSuccess =
  utf8Bytes(JSON.stringify({ accountId: '' })) + ACCOUNT_OPERATION_ACCOUNT_ID_MAX_LENGTH;
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

