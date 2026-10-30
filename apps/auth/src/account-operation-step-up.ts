import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import type { AccountOperation } from './account-operations';

export type AccountOperationStepUpKind = 'organization' | 'delete';

export type PendingAccountOperationStepUp = {
  kind: AccountOperationStepUpKind;
  accountId: string;
  operationKey: string;
  operation: AccountOperation;
  returnTo: '/organizations/new' | '/account/delete';
};

export type AccountOperationStepUpSelection =
  | { kind: 'ordinary' }
  | { kind: 'invalid' }
  | { kind: 'operation'; pending: PendingAccountOperationStepUp };

export type PendingAccountOperationStepUpState =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'pending'; value: PendingAccountOperationStepUp };

const storageKey = 'rezics.account-operation.step-up';
const queryKey = 'account_operation';
const returnTargets = {
  organization: '/organizations/new',
  delete: '/account/delete',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOperation(value: unknown, kind: AccountOperationStepUpKind): value is AccountOperation {
  if (!isRecord(value) || value.kind !== kind) return false;
  const keys = Object.keys(value).sort().join(',');
  if (kind === 'organization')
    return (
      keys === 'handle,kind' &&
      typeof value.handle === 'string' &&
      /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(value.handle)
    );
  return keys === 'accountId,kind' && typeof value.accountId === 'string' && value.accountId.length > 0;
}

function isPending(value: unknown): value is PendingAccountOperationStepUp {
  if (!isRecord(value) || (value.kind !== 'organization' && value.kind !== 'delete')) return false;
  const kind = value.kind;
  return (
    value.version === 1 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    typeof value.operationKey === 'string' &&
    /^[a-f0-9]{32}$/.test(value.operationKey) &&
    value.returnTo === returnTargets[kind] &&
    isOperation(value.operation, kind) &&
    (kind === 'organization' ||
      (value.operation as Extract<AccountOperation, { kind: 'delete' }>).accountId === value.accountId)
  );
}

export function accountOperationProfile(kind: AccountOperationStepUpKind) {
  return {
    client_id: AUTH_PAGE_OPERATION_CLIENT_ID,
    scope: [...AUTH_PAGE_OPERATION_SCOPES[kind]],
  };
}

export function accountOperationSessionMatches(
  session: { accountId: string; clientId?: string; scopes?: readonly string[] },
  pending: PendingAccountOperationStepUp,
): boolean {
  const expected = accountOperationProfile(pending.kind);
  return (
    session.accountId === pending.accountId &&
    session.clientId === expected.client_id &&
    Array.isArray(session.scopes) &&
    session.scopes.length === expected.scope.length &&
    expected.scope.every((scope, index) => session.scopes![index] === scope)
  );
}

export function storePendingAccountOperationStepUp(input: Omit<PendingAccountOperationStepUp, 'returnTo'>): boolean {
  const pending = { ...input, returnTo: returnTargets[input.kind], version: 1 };
  if (!isPending(pending)) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function pendingAccountOperationStepUpState(): PendingAccountOperationStepUpState {
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored === null) return { kind: 'absent' };
    const value: unknown = JSON.parse(stored);
    if (!isPending(value)) return { kind: 'invalid' };
    const { version: _version, ...pending } = value as PendingAccountOperationStepUp & { version: 1 };
    return { kind: 'pending', value: pending };
  } catch {
    // Storage access can be disabled; without a saved continuation the operation page can still use its normal flow.
    return { kind: 'absent' };
  }
}

export function readPendingAccountOperationStepUp(): PendingAccountOperationStepUp | null {
  const state = pendingAccountOperationStepUpState();
  return state.kind === 'pending' ? state.value : null;
}

export function clearPendingAccountOperationStepUp(): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Session storage can be unavailable; it is only a continuation hint.
  }
}

export function accountOperationStepUpUrl(kind: AccountOperationStepUpKind): string {
  const query = new URLSearchParams({ [queryKey]: kind, return_to: returnTargets[kind] });
  return `/step-up?${query.toString()}`;
}

export function selectAccountOperationStepUp(query: string): AccountOperationStepUpSelection {
  const parameters = new URLSearchParams(query);
  const marker = parameters.get(queryKey);
  const returnTo = parameters.get('return_to');
  const operationReturn = returnTo === returnTargets.organization || returnTo === returnTargets.delete;
  if (marker === null && !operationReturn) return { kind: 'ordinary' };
  if (
    (marker !== 'organization' && marker !== 'delete') ||
    parameters.getAll(queryKey).length !== 1 ||
    parameters.getAll('return_to').length !== 1 ||
    parameters.size !== 2
  )
    return { kind: 'invalid' };
  const state = pendingAccountOperationStepUpState();
  const pending = state.kind === 'pending' ? state.value : null;
  if (!pending || pending.kind !== marker || pending.returnTo !== returnTo) return { kind: 'invalid' };
  return { kind: 'operation', pending };
}

export function pendingAccountOperationMatches(
  pending: PendingAccountOperationStepUp | null,
  accountId: string,
  operationKey: string,
  operation: AccountOperation,
): boolean {
  if (!pending || pending.accountId !== accountId || pending.operationKey !== operationKey) return false;
  if (pending.kind !== operation.kind) return false;
  if (operation.kind === 'organization')
    return pending.operation.kind === 'organization' && pending.operation.handle === operation.handle;
  return pending.operation.kind === 'delete' && pending.operation.accountId === operation.accountId;
}
