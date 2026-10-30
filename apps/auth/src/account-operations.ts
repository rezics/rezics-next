import { authPost, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';

export type AccountOperation = { kind: 'delete'; accountId: string } | { kind: 'organization'; handle: string };

export type AccountSessionResult =
  | { kind: 'ready'; accountId: string; clientId?: string; scopes?: string[] }
  | { kind: 'signed-out' }
  | { kind: 'failure'; message: string };

export type AccountOperationResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'step-up' | 'platform-closed' | 'denied' | 'failure' };

const operationStorageKey = 'rezics.account-operation.pending';
const organizationHandleStorageKey = 'rezics.organization.pending-handle';

type StoredOperationKey = { signature: string; key: string };
let memoryOperationKey: StoredOperationKey | null = null;

export async function loadAccountSession(): Promise<AccountSessionResult> {
  try {
    const response = await fetch('/session', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status !== 200) return { kind: 'failure', message: m.auth_account_operation_failure() };
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('account_id' in body) ||
      typeof body.account_id !== 'string' ||
      !body.account_id
    )
      return { kind: 'failure', message: m.auth_account_operation_failure() };
    const clientId = 'client_id' in body ? body.client_id : undefined;
    const scopes = 'scope' in body ? body.scope : undefined;
    if (
      (clientId !== undefined && typeof clientId !== 'string') ||
      (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')))
    )
      return { kind: 'failure', message: m.auth_account_operation_failure() };
    return {
      kind: 'ready',
      accountId: body.account_id,
      ...(typeof clientId === 'string' ? { clientId } : {}),
      ...(Array.isArray(scopes) ? { scopes: scopes as string[] } : {}),
    };
  } catch {
    return { kind: 'failure', message: m.auth_account_operation_failure() };
  }
}

function post<Body>(path: string, body: unknown): Promise<AuthPostResult<Body>> {
  return authPost<Body>(path, body).then((first) => {
    if (!first.ok && first.status === 503 && first.code === 'unavailable') return authPost<Body>(path, body);
    return first;
  });
}

function failure(result: Exclude<AuthPostResult, { ok: true }>): AccountOperationResult {
  if (result.status === 401 && result.code === 'step_up_required') return { ok: false, reason: 'step-up' };
  if (result.status === 403 && result.code === 'platform_closed') return { ok: false, reason: 'platform-closed' };
  if (result.status === 409 && result.code === 'account_operation_denied') return { ok: false, reason: 'denied' };
  return { ok: false, reason: 'failure' };
}

export async function runAccountOperation(
  operationKey: string,
  operation: AccountOperation,
): Promise<AccountOperationResult> {
  const approved = await post<{ reference?: unknown; expiresAt?: unknown }>('/account-operations/approve', {
    operationKey,
    operation,
  });
  if (!approved.ok) return failure(approved);
  if (typeof approved.body.reference !== 'string' || !approved.body.reference) return { ok: false, reason: 'failure' };

  const executed = await post<{ accountId?: unknown }>('/account-operations/execute', {
    operationKey,
    operation,
    reference: approved.body.reference,
  });
  if (!executed.ok) return failure(executed);
  if (typeof executed.body.accountId !== 'string' || !executed.body.accountId) return { ok: false, reason: 'failure' };
  return { ok: true, accountId: executed.body.accountId };
}

export function operationKeyFor(operation: AccountOperation): string {
  const signature = JSON.stringify(operation);
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(operationStorageKey) ?? 'null');
    if (
      stored &&
      typeof stored === 'object' &&
      'signature' in stored &&
      stored.signature === signature &&
      'key' in stored &&
      typeof stored.key === 'string' &&
      stored.key
    )
      return stored.key;
  } catch {
    // Use the in-memory key when storage is unavailable.
  }
  if (memoryOperationKey?.signature === signature) return memoryOperationKey.key;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  memoryOperationKey = { signature, key };
  try {
    window.sessionStorage.setItem(operationStorageKey, JSON.stringify(memoryOperationKey));
  } catch {
    // The in-memory copy keeps retries stable without storage.
  }
  return key;
}

export function forgetOperationKey(operation: AccountOperation): void {
  const signature = JSON.stringify(operation);
  if (memoryOperationKey?.signature === signature) memoryOperationKey = null;
  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem(operationStorageKey) ?? 'null',
    ) as StoredOperationKey | null;
    if (stored?.signature === signature) window.sessionStorage.removeItem(operationStorageKey);
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
