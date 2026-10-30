import { accountOperationProfile } from './account-operation-step-up';

const storageKey = 'rezics.organization-delete.step-up';
export const organizationDeleteReturnTo = '/organizations/delete' as const;
export const organizationDeleteStepUpUrl = '/step-up?organization_delete=1&return_to=%2Forganizations%2Fdelete';

export type PendingOrganizationDelete = {
  version: 1;
  operation: 'delete';
  humanAccountId: string;
  organizationId: string;
  operationKey: string;
  returnTo: typeof organizationDeleteReturnTo;
};
export type OrganizationDeletePendingState =
  | { kind: 'absent' | 'invalid' }
  | { kind: 'pending'; value: PendingOrganizationDelete };

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function valid(value: unknown): value is PendingOrganizationDelete {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'humanAccountId,operation,operationKey,organizationId,returnTo,version' &&
    record.version === 1 &&
    record.operation === 'delete' &&
    isAccountId(record.humanAccountId) &&
    isAccountId(record.organizationId) &&
    record.humanAccountId !== record.organizationId &&
    typeof record.operationKey === 'string' &&
    /^[a-f0-9]{32}$/.test(record.operationKey) &&
    record.returnTo === organizationDeleteReturnTo
  );
}

function readStored(key: string): OrganizationDeletePendingState {
  try {
    const stored = window.sessionStorage.getItem(key);
    if (stored === null) return { kind: 'absent' };
    const value: unknown = JSON.parse(stored);
    return valid(value) ? { kind: 'pending', value } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function readOrganizationDeleteStepUp(): OrganizationDeletePendingState {
  return readStored(storageKey);
}

// Only minimal retry identity is retained, never approval/reference or private facts.
export function readOrganizationDeleteUnknown(organizationId: string): OrganizationDeletePendingState {
  return readStored(`${storageKey}.unknown.${organizationId}`);
}

export function clearOrganizationDeleteUnknown(organizationId: string): void {
  try {
    window.sessionStorage.removeItem(`${storageKey}.unknown.${organizationId}`);
  } catch {
    /* Keep unknown on failure. */
  }
}

export function storeOrganizationDeleteUnknown(value: PendingOrganizationDelete): void {
  if (!valid(value)) return;
  window.sessionStorage.setItem(`${storageKey}.unknown.${value.organizationId}`, JSON.stringify(value));
}

export function clearOrganizationDeleteStepUp(): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* Continuation only. */
  }
}

export function storeOrganizationDeleteStepUp(
  input: Omit<PendingOrganizationDelete, 'version' | 'returnTo' | 'operation'>,
): boolean {
  const value = { ...input, version: 1, operation: 'delete', returnTo: organizationDeleteReturnTo };
  if (!valid(value)) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function organizationDeleteSessionMatches(
  session: { accountId: string; clientId?: string; scopes?: readonly string[] },
  pending: PendingOrganizationDelete,
): boolean {
  const expected = accountOperationProfile('delete');
  return (
    session.accountId === pending.humanAccountId &&
    session.clientId === expected.client_id &&
    session.scopes?.length === expected.scope.length &&
    expected.scope.every((scope, index) => session.scopes![index] === scope)
  );
}

export function organizationDeletePendingMatches(
  pending: PendingOrganizationDelete,
  humanAccountId: string,
  organizationId: string,
  operationKey: string,
): boolean {
  return (
    pending.humanAccountId === humanAccountId &&
    pending.organizationId === organizationId &&
    pending.operationKey === operationKey
  );
}

export function selectOrganizationDeleteStepUp(
  query: string,
): { kind: 'ordinary' | 'invalid' } | { kind: 'organization-delete'; pending: PendingOrganizationDelete } {
  const parameters = new URLSearchParams(query);
  if (!parameters.has('organization_delete') && parameters.get('return_to') !== organizationDeleteReturnTo)
    return { kind: 'ordinary' };
  if (
    parameters.size !== 2 ||
    parameters.getAll('organization_delete').length !== 1 ||
    parameters.get('organization_delete') !== '1' ||
    parameters.getAll('return_to').length !== 1 ||
    parameters.get('return_to') !== organizationDeleteReturnTo
  )
    return { kind: 'invalid' };
  const state = readOrganizationDeleteStepUp();
  return state.kind === 'pending' ? { kind: 'organization-delete', pending: state.value } : { kind: 'invalid' };
}
