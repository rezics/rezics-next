import { privateAuthRead } from './private-auth-read';
import { authPost, AUTH_POST_TIMEOUT_MS, type AuthPostResult } from './api';
import {
  ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES,
  ACCOUNT_OPERATION_MAX_ERROR_BYTES,
  ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES,
  parseAccountOperationApprovalResponse,
  parseOrganizationExecutionResponse,
  parseOrganizationOperationError,
} from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { requestAccountSession } from './account-session';
import { m } from './paraglide/messages.js';
import { normalizeSignupHandle } from './signup';

export type AccountOperation = { kind: 'delete'; accountId: string } | { kind: 'organization'; handle: string };

export type AccountSessionResult =
  | { kind: 'ready'; accountId: string; clientId?: string; scopes?: string[] }
  | { kind: 'signed-out' }
  | { kind: 'failure'; message: string };

export type AccountOperationResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'step-up' | 'platform-closed' | 'denied' | 'unavailable' | 'unknown' | 'failure' };

const operationStorageKey = 'rezics.account-operation.pending';
const organizationHandleStorageKey = 'rezics.organization.pending-handle';
const maxAccountIdCodeUnits = 4096;
const maxOperationKeyCodeUnits = 128;
const deleteSignatureBase = JSON.stringify(['', { kind: 'delete', accountId: '' }])!.length;
const deleteEnvelopeBase = JSON.stringify({
  signature: JSON.stringify(['', { kind: 'delete', accountId: '' }]),
  key: '',
})!.length;
const maxOperationSignatureCodeUnits = deleteSignatureBase + 6 * (2 * maxAccountIdCodeUnits);
/** Raw UTF-16 bound for the current nested JSON writer and native-admitted operands. */
export const ACCOUNT_OPERATION_KEY_STORAGE_LIMIT =
  deleteEnvelopeBase + 7 * (2 * maxAccountIdCodeUnits) + 6 * maxOperationKeyCodeUnits;

type StoredOperationKey = { signature: string; key: string };
export type OperationKeyResult = { kind: 'ready'; key: string } | { kind: 'refused' };
type StoredOperationKeyRead =
  | { kind: 'absent' | 'unavailable' | 'refused' }
  | { kind: 'stored'; value: StoredOperationKey };
let memoryOperationKey: StoredOperationKey | null = null;

const invalidJson = Symbol('invalid JSON');

function parseJson(raw: string): unknown | typeof invalidJson {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return invalidJson;
    throw error;
  }
}

function accountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxAccountIdCodeUnits;
}

function operationRecord(value: unknown): value is AccountOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind === 'delete')
    return keys.length === 2 && keys.includes('kind') && keys.includes('accountId') && accountId(record.accountId);
  return (
    record.kind === 'organization' &&
    keys.length === 2 &&
    keys.includes('kind') &&
    keys.includes('handle') &&
    typeof record.handle === 'string' &&
    normalizeSignupHandle(record.handle) === record.handle
  );
}

function operationSignature(operation: AccountOperation, actorAccountId?: string): string | null {
  if ((actorAccountId !== undefined && !accountId(actorAccountId)) || !operationRecord(operation)) return null;
  const actor = actorAccountId ?? (operation.kind === 'delete' ? operation.accountId : null);
  const canonicalOperation: AccountOperation =
    operation.kind === 'delete'
      ? { kind: 'delete', accountId: operation.accountId }
      : { kind: 'organization', handle: operation.handle };
  return JSON.stringify([actor, canonicalOperation]);
}

function validOperationKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxOperationKeyCodeUnits;
}

function validSignature(value: string): boolean {
  if (value.length > maxOperationSignatureCodeUnits) return false;
  const parsed = parseJson(value);
  if (parsed === invalidJson || !Array.isArray(parsed) || parsed.length !== 2) return false;
  const [actor, operation] = parsed as unknown[];
  if ((actor !== null && !accountId(actor)) || !operationRecord(operation)) return false;
  if (operation.kind === 'delete' && actor === null) return false;
  return JSON.stringify([actor, operation]) === value;
}

function readStoredOperationKey(): StoredOperationKeyRead {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(operationStorageKey);
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw === null) return { kind: 'absent' };
  if (raw.length > ACCOUNT_OPERATION_KEY_STORAGE_LIMIT) return { kind: 'refused' };
  const parsed = parseJson(raw);
  if (
    parsed === invalidJson ||
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, 'signature') ||
    !Object.hasOwn(parsed, 'key')
  )
    return { kind: 'refused' };
  const record = parsed as Record<string, unknown>;
  const signature = record.signature;
  const key = record.key;
  if (
    typeof signature !== 'string' ||
    !validOperationKey(key) ||
    !validSignature(signature) ||
    JSON.stringify(record) !== raw
  )
    return { kind: 'refused' };
  return { kind: 'stored', value: { signature, key } };
}

function memoryKey(signature: string): string | null {
  return memoryOperationKey?.signature === signature ? memoryOperationKey.key : null;
}

function allocateOperationKey(signature: string, persist: boolean): OperationKeyResult {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  memoryOperationKey = { signature, key };
  if (persist) {
    try {
      window.sessionStorage.setItem(operationStorageKey, JSON.stringify(memoryOperationKey));
    } catch {
      // The in-memory copy keeps retries stable when browser storage is unavailable.
    }
  }
  return { kind: 'ready', key };
}

export async function loadAccountSession(signal?: AbortSignal): Promise<AccountSessionResult> {
  try {
    const result = await privateAuthRead((readSignal) => requestAccountSession(readSignal), signal);
    return result.kind === 'failure' ? { kind: 'failure', message: m.auth_account_operation_failure() } : result;
  } catch {
    return { kind: 'failure', message: m.auth_account_operation_failure() };
  }
}

async function post<Body>(path: string, body: unknown, isCurrent?: () => boolean): Promise<AuthPostResult<Body>> {
  const first = await authPost<Body>(path, body);
  if (!first.ok && first.status === 503 && first.code === 'unavailable' && (!isCurrent || isCurrent()))
    return authPost<Body>(path, body);
  return first;
}

function failure(result: Exclude<AuthPostResult, { ok: true }>): AccountOperationResult {
  if (result.status === 401 && result.code === 'step_up_required') return { ok: false, reason: 'step-up' };
  if (result.status === 403 && result.code === 'platform_closed') return { ok: false, reason: 'platform-closed' };
  if (result.status === 409 && result.code === 'account_operation_denied') return { ok: false, reason: 'denied' };
  if (result.status === 401 && result.code === 'account_operation_denied') return { ok: false, reason: 'denied' };
  if (result.status === 403 && result.code === 'account_operation_denied') return { ok: false, reason: 'denied' };
  if (result.status === 503) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: 'failure' };
}

type OrganizationReply<T> =
  | { kind: 'received'; value: T }
  | { kind: 'error'; reason: 'step-up' | 'platform-closed' | 'denied' | 'unavailable' }
  | { kind: 'invalid' };

/** One existing five-second lifetime per POST, including abort-ignoring I/O. */
async function organizationPost<T>(
  phase: 'approve' | 'execute',
  body: unknown,
  maxBytes: number,
  parse: (value: unknown) => T | null,
  dispatch: () => boolean,
  caller?: AbortSignal,
): Promise<OrganizationReply<T>> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  const timer = setTimeout(cancel, AUTH_POST_TIMEOUT_MS);
  let onAbort = () => {};
  try {
    const cancelled = new Promise<OrganizationReply<T>>((resolve) => {
      onAbort = () => resolve({ kind: 'invalid' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const send = async (): Promise<OrganizationReply<T>> => {
      if (controller.signal.aborted) return { kind: 'invalid' };
      if (!dispatch()) return { kind: 'invalid' };
      const payload = JSON.stringify(body);
      let response: Response;
      let value: unknown;
      try {
        response = await fetch(`/account-operations/${phase}`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: controller.signal,
        });
        value = await readJsonBounded(
          response,
          response.status === 200 ? maxBytes : ACCOUNT_OPERATION_MAX_ERROR_BYTES,
          controller.signal,
        );
      } catch {
        return { kind: 'invalid' };
      }
      if (response.status === 200) {
        const result = parse(value);
        return result ? { kind: 'received', value: result } : { kind: 'invalid' };
      }
      const error = parseOrganizationOperationError(value, response.status);
      if (!error) return { kind: 'invalid' };
      const reason =
        error.error === 'step_up_required'
          ? 'step-up'
          : error.error === 'platform_closed'
            ? 'platform-closed'
            : error.error === 'account_operation_denied'
              ? 'denied'
              : 'unavailable';
      return { kind: 'error', reason };
    };
    return await Promise.race([cancelled, send()]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function runOrganizationOperation(
  operationKey: string,
  operation: Extract<AccountOperation, { kind: 'organization' }>,
  browser?: { isCurrent: () => boolean; signal?: AbortSignal; onExecutionDispatch?: () => boolean },
): Promise<AccountOperationResult> {
  const owns = () => !browser?.signal?.aborted && (!browser || browser.isCurrent());
  const approve = () =>
    organizationPost(
      'approve',
      { operationKey, operation },
      ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES,
      parseAccountOperationApprovalResponse,
      owns,
      browser?.signal,
    );
  let approved = await approve();
  if (!owns()) return { ok: false, reason: 'failure' };
  if (approved.kind === 'error' && approved.reason === 'unavailable') approved = await approve();
  if (!owns()) return { ok: false, reason: 'failure' };
  if (approved.kind !== 'received')
    return { ok: false, reason: approved.kind === 'error' ? approved.reason : 'unavailable' };
  if (Date.parse(approved.value.expiresAt) <= Date.now()) return { ok: false, reason: 'unavailable' };
  const executed = await organizationPost(
    'execute',
    { operationKey, operation, reference: approved.value.reference },
    ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES,
    parseOrganizationExecutionResponse,
    () => owns() && (!browser?.onExecutionDispatch || browser.onExecutionDispatch()) && owns(),
    browser?.signal,
  );
  if (!owns()) return { ok: false, reason: 'failure' };
  if (executed.kind === 'received') return { ok: true, accountId: executed.value.accountId };
  return {
    ok: false,
    reason: executed.kind === 'error' && executed.reason !== 'unavailable' ? executed.reason : 'unknown',
  };
}

export async function runAccountOperation(
  operationKey: string,
  operation: AccountOperation,
  browser?: {
    isCurrent: () => boolean;
    retryUncertain?: boolean;
    onExecutionDispatch?: () => boolean;
    signal?: AbortSignal;
  },
): Promise<AccountOperationResult> {
  if (operation.kind === 'organization') return runOrganizationOperation(operationKey, operation, browser);
  if (browser && !browser.isCurrent()) return { ok: false, reason: 'failure' };
  const approved = await post<{ reference?: unknown; expiresAt?: unknown }>(
    '/account-operations/approve',
    { operationKey, operation },
    browser?.onExecutionDispatch ? browser.isCurrent : undefined,
  );
  if (browser && !browser.isCurrent()) return { ok: false, reason: 'failure' };
  if (!approved.ok) return failure(approved);
  if (
    !approved.body ||
    typeof approved.body.reference !== 'string' ||
    !approved.body.reference ||
    typeof approved.body.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(approved.body.expiresAt))
  )
    return { ok: false, reason: 'unavailable' };

  const executionBody = {
    operationKey,
    operation,
    reference: approved.body.reference,
  };
  if (browser?.onExecutionDispatch && !browser.onExecutionDispatch()) return { ok: false, reason: 'failure' };
  if (browser && !browser.isCurrent()) return { ok: false, reason: 'failure' };
  // Keep the same reference/body/key for the existing unavailable retry. A timeout
  // ends waiting with an unknown outcome; recovery must remain explicit.
  let executed = await authPost<{ accountId?: unknown; expired?: unknown; error?: unknown }>(
    '/account-operations/execute',
    executionBody,
  );
  const uncertain = !executed.ok && executed.status === 503;
  // Deletion retains its bounded same-body recovery for unavailable responses only
  // while its review owns the command. Creation requires explicit review.
  if (
    (!browser || (browser.retryUncertain && browser.isCurrent())) &&
    uncertain &&
    !executed.ok &&
    executed.code === 'unavailable'
  )
    executed = await authPost('/account-operations/execute', executionBody);
  if (!executed.ok) return uncertain ? { ok: false, reason: 'unknown' } : failure(executed);
  if (
    !executed.body ||
    executed.body.expired ||
    executed.body.error ||
    typeof executed.body.accountId !== 'string' ||
    !executed.body.accountId ||
    (operation.kind === 'delete' && executed.body.accountId !== operation.accountId)
  )
    return { ok: false, reason: 'unknown' };
  return { ok: true, accountId: executed.body.accountId };
}

export function operationKeyFor(
  operation: AccountOperation,
  actorAccountId?: string,
  retainedKey?: string,
): OperationKeyResult {
  const signature = operationSignature(operation, actorAccountId);
  if (!signature || (retainedKey !== undefined && !validOperationKey(retainedKey))) return { kind: 'refused' };

  const stored = readStoredOperationKey();
  if (stored.kind === 'refused') return { kind: 'refused' };
  if (retainedKey !== undefined) {
    memoryOperationKey = { signature, key: retainedKey };
    return { kind: 'ready', key: retainedKey };
  }
  if (stored.kind === 'stored' && stored.value.signature === signature) {
    memoryOperationKey = stored.value;
    return { kind: 'ready', key: stored.value.key };
  }
  const inMemory = memoryKey(signature);
  if (inMemory !== null) return { kind: 'ready', key: inMemory };
  return allocateOperationKey(signature, stored.kind !== 'unavailable');
}

export function forgetOperationKey(operation: AccountOperation, actorAccountId?: string, expectedKey?: string): void {
  const signature = operationSignature(operation, actorAccountId);
  if (!signature || (expectedKey !== undefined && !validOperationKey(expectedKey))) return;
  const stored = readStoredOperationKey();
  if (stored.kind === 'refused') return;

  if (
    memoryOperationKey?.signature === signature &&
    (expectedKey === undefined || memoryOperationKey.key === expectedKey)
  )
    memoryOperationKey = null;
  if (
    stored.kind !== 'stored' ||
    stored.value.signature !== signature ||
    (expectedKey !== undefined && stored.value.key !== expectedKey)
  )
    return;
  try {
    window.sessionStorage.removeItem(operationStorageKey);
  } catch {
    // Storage may be disabled by the browser.
  }
}

export function readPendingOrganizationHandle(): string {
  try {
    return window.sessionStorage.getItem(organizationHandleStorageKey) ?? '';
  } catch {
    return '';
  }
}

export function storePendingOrganizationHandle(handle: string): void {
  try {
    if (handle) window.sessionStorage.setItem(organizationHandleStorageKey, handle);
    else window.sessionStorage.removeItem(organizationHandleStorageKey);
  } catch {
    // Storage may be disabled by the browser.
  }
}
