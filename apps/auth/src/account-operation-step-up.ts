import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import type { AccountOperation } from './account-operations';

export type AccountOperationStepUpKind = 'organization' | 'delete';

export type PendingAccountOperationStepUp = {
  kind: AccountOperationStepUpKind;
  accountId: string;
  operationKey: string;
  operation: AccountOperation;
  returnTo: '/organizations/new' | '/account/delete';
  /** Departure hint only. Older continuations may already have been submitted. */
  submitted?: boolean;
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
/** UTF-16 code units (`String.length`): delete stores the account ID twice. */
export const ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT = 64 * 1024;
const maxAccountIdCodeUnits = 4096;
const returnTargets = {
  organization: '/organizations/new',
  delete: '/account/delete',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.length === required.length + optional.filter((key) => Object.hasOwn(value, key)).length &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isOperation(value: unknown, kind: AccountOperationStepUpKind): value is AccountOperation {
  if (!isRecord(value) || value.kind !== kind) return false;
  if (kind === 'organization')
    return (
      hasExactKeys(value, ['kind', 'handle']) &&
      typeof value.handle === 'string' &&
      /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(value.handle)
    );
  return (
    hasExactKeys(value, ['kind', 'accountId']) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= maxAccountIdCodeUnits
  );
}

function isPending(value: unknown): value is PendingAccountOperationStepUp {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'kind', 'accountId', 'operationKey', 'operation', 'returnTo'], ['submitted']) ||
    (value.kind !== 'organization' && value.kind !== 'delete')
  )
    return false;
  const kind = value.kind;
  return (
    value.version === 1 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= maxAccountIdCodeUnits &&
    typeof value.operationKey === 'string' &&
    /^[a-f0-9]{32}$/.test(value.operationKey) &&
    value.returnTo === returnTargets[kind] &&
    (value.submitted === undefined || typeof value.submitted === 'boolean') &&
    isOperation(value.operation, kind) &&
    (kind === 'organization' ||
      (value.operation as Extract<AccountOperation, { kind: 'delete' }>).accountId === value.accountId)
  );
}

function canonicalOperation(value: unknown, kind: AccountOperationStepUpKind): AccountOperation | null {
  if (!isOperation(value, kind)) return null;
  if (kind === 'organization')
    return { kind, handle: (value as Extract<AccountOperation, { kind: 'organization' }>).handle };
  return { kind, accountId: (value as Extract<AccountOperation, { kind: 'delete' }>).accountId };
}

function canonicalPending(value: unknown): (PendingAccountOperationStepUp & { version: 1 }) | null {
  if (!isPending(value)) return null;
  const operation = canonicalOperation(value.operation, value.kind);
  if (!operation) return null;
  return {
    kind: value.kind,
    accountId: value.accountId,
    operationKey: value.operationKey,
    operation,
    returnTo: value.returnTo,
    ...(typeof value.submitted === 'boolean' ? { submitted: value.submitted } : {}),
    version: 1,
  };
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
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ['kind', 'accountId', 'operationKey', 'operation'], ['submitted']) ||
    (candidate.kind !== 'organization' && candidate.kind !== 'delete') ||
    typeof candidate.accountId !== 'string' ||
    candidate.accountId.length === 0 ||
    candidate.accountId.length > maxAccountIdCodeUnits ||
    typeof candidate.operationKey !== 'string' ||
    !/^[a-f0-9]{32}$/.test(candidate.operationKey) ||
    (candidate.submitted !== undefined && typeof candidate.submitted !== 'boolean')
  )
    return false;
  const operation = canonicalOperation(candidate.operation, candidate.kind);
  if (!operation) return false;
  const pending = canonicalPending({
    kind: candidate.kind,
    accountId: candidate.accountId,
    operationKey: candidate.operationKey,
    operation,
    returnTo: returnTargets[candidate.kind],
    ...(typeof candidate.submitted === 'boolean' ? { submitted: candidate.submitted } : {}),
    version: 1,
  });
  if (!pending) return false;
  const serialized = JSON.stringify(pending);
  if (serialized.length > ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}

export function pendingAccountOperationStepUpState(): PendingAccountOperationStepUpState {
  let stored: string | null;
  try {
    stored = window.sessionStorage.getItem(storageKey);
  } catch {
    // Storage access can be disabled; without a saved continuation the operation page can still use its normal flow.
    return { kind: 'absent' };
  }
  if (stored === null) return { kind: 'absent' };
  if (stored.length > ACCOUNT_OPERATION_STEP_UP_STORAGE_LIMIT) return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return { kind: 'invalid' };
  }
  const canonical = canonicalPending(value);
  if (!canonical) return { kind: 'invalid' };
  const { version: _version, ...pending } = canonical;
  return { kind: 'pending', value: pending };
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
