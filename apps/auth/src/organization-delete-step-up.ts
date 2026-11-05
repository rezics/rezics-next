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

/** Exact raw UTF-16 ceiling for the fixed version-1 descriptor (231 code units). */
export const ORGANIZATION_DELETE_DESCRIPTOR_MAX_RAW_UTF16 = JSON.stringify({
  humanAccountId: '0'.repeat(36),
  organizationId: '0'.repeat(36),
  operationKey: '0'.repeat(32),
  version: 1,
  operation: 'delete',
  returnTo: organizationDeleteReturnTo,
}).length;

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

export function sameOrganizationDeleteDescriptor(
  left: PendingOrganizationDelete,
  right: PendingOrganizationDelete,
): boolean {
  return (
    left.version === right.version &&
    left.operation === right.operation &&
    left.humanAccountId === right.humanAccountId &&
    left.organizationId === right.organizationId &&
    left.operationKey === right.operationKey &&
    left.returnTo === right.returnTo
  );
}

function readStored(key: string): OrganizationDeletePendingState {
  try {
    const stored = window.sessionStorage.getItem(key);
    if (stored === null) return { kind: 'absent' };
    if (stored.length > ORGANIZATION_DELETE_DESCRIPTOR_MAX_RAW_UTF16) return { kind: 'invalid' };
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
  const state = readStored(`${storageKey}.unknown.${organizationId}`);
  return state.kind === 'pending' && state.value.organizationId !== organizationId ? { kind: 'invalid' } : state;
}

function clearStored(key: string, expected: PendingOrganizationDelete): boolean {
  if (!valid(expected)) return false;
  const current = readStored(key);
  if (current.kind !== 'pending' || !sameOrganizationDeleteDescriptor(current.value, expected)) return false;
  try {
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function clearOrganizationDeleteUnknown(organizationId: string, expected: PendingOrganizationDelete): boolean {
  return clearStored(`${storageKey}.unknown.${organizationId}`, expected);
}

function storeDescriptor(key: string, value: PendingOrganizationDelete): boolean {
  if (!valid(value)) return false;
  const raw = JSON.stringify(value);
  if (raw.length > ORGANIZATION_DELETE_DESCRIPTOR_MAX_RAW_UTF16) return false;
  const existing = readStored(key);
  if (
    existing.kind === 'invalid' ||
    (existing.kind === 'pending' && !sameOrganizationDeleteDescriptor(existing.value, value))
  )
    return false;
  try {
    window.sessionStorage.setItem(key, raw);
    const stored = readStored(key);
    return stored.kind === 'pending' && sameOrganizationDeleteDescriptor(stored.value, value);
  } catch {
    return false;
  }
}

export function storeOrganizationDeleteUnknown(value: PendingOrganizationDelete): boolean {
  return storeDescriptor(`${storageKey}.unknown.${value.organizationId}`, value);
}

export function clearOrganizationDeleteStepUp(expected: PendingOrganizationDelete): boolean {
  return clearStored(storageKey, expected);
}

export function storeOrganizationDeleteStepUp(
  input: Omit<PendingOrganizationDelete, 'version' | 'returnTo' | 'operation'>,
): boolean {
  const value: PendingOrganizationDelete = {
    ...input,
    version: 1,
    operation: 'delete',
    returnTo: organizationDeleteReturnTo,
  };
  return storeDescriptor(storageKey, value);
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
