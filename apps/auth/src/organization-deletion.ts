import {
  loadAccountSession,
  runAccountOperation,
  type AccountOperationResult,
  type AccountSessionResult,
} from './account-operations';
import { accountOperationProfile } from './account-operation-step-up';
import {
  isAccountId,
  readOrganizationDeleteUnknown,
  storeOrganizationDeleteUnknown,
  clearOrganizationDeleteUnknown,
  organizationDeleteReturnTo,
} from './organization-delete-step-up';

// Projection of the native private management read, never a public attribution
// lookup or client-computed management decision. The adapter must authenticate
// the real initiating human and apply current native read/manager authority.
export type OrganizationDeletionRead =
  | {
      kind: 'ready';
      account: { id: string; kind: 'organization' | 'actor'; handle: string | null; displayName: string | null };
    }
  | { kind: 'signed-out' | 'denied' | 'missing' | 'unavailable' };
export type OrganizationDeletionReader = (input: {
  humanAccountId: string;
  organizationId: string;
}) => Promise<OrganizationDeletionRead>;

// Access exposes GET /v1/accounts/{accountId}/management, but this issuer has no
// cookie-authenticated native read binding. The fixed delete profile cannot be
// expanded with account:read or replaced by the website client's bearer. Auth's
// host composition must supply that real binding before this page can approve.
export const missingOrganizationDeletionReadPort = 'Auth issuer → native GET /v1/accounts/{accountId}/management';
export const readCurrentOrganizationForDeletion: OrganizationDeletionReader = async () => ({ kind: 'unavailable' });

export type OrganizationDeletionTarget = {
  humanAccountId: string;
  organizationId: string;
  handle: string | null;
  displayName: string | null;
  session: Extract<AccountSessionResult, { kind: 'ready' }>;
};
export type OrganizationDeletionLoad =
  | { kind: 'ready'; target: OrganizationDeletionTarget }
  | { kind: 'signed-out' | 'denied' | 'missing' | 'unavailable' };

export async function loadOrganizationDeletion(
  organizationId: string,
  read: OrganizationDeletionReader = readCurrentOrganizationForDeletion,
): Promise<OrganizationDeletionLoad> {
  if (!isAccountId(organizationId)) return { kind: 'missing' };
  const session = await loadAccountSession();
  if (session.kind === 'signed-out') return session;
  if (session.kind !== 'ready') return { kind: 'unavailable' };
  if (!isAccountId(session.accountId) || session.accountId === organizationId) return { kind: 'denied' };
  try {
    const result = await read({ humanAccountId: session.accountId, organizationId });
    if (result.kind !== 'ready') return result;
    if (result.account.id !== organizationId || result.account.kind !== 'organization') return { kind: 'denied' };
    // Only the current native read's allowlisted identity fields reach the page.
    return {
      kind: 'ready',
      target: {
        humanAccountId: session.accountId,
        organizationId,
        session,
        handle: result.account.handle,
        displayName: result.account.displayName,
      },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function organizationDeleteConfirmation(target: OrganizationDeletionTarget, fallback: string): string {
  return target.handle ? `@${target.handle}` : target.displayName || fallback;
}
export function organizationDeleteConfirmed(value: string, expected: string): boolean {
  const normalize = (input: string) => input.trim().normalize('NFC').toLowerCase();
  return normalize(value) === normalize(expected);
}

export async function executeOrganizationDeletion(
  target: OrganizationDeletionTarget,
  operationKey: string,
  read: OrganizationDeletionReader = readCurrentOrganizationForDeletion,
): Promise<AccountOperationResult | { ok: false; reason: 'changed' }> {
  if (!/^[a-f0-9]{32}$/.test(operationKey)) return { ok: false, reason: 'changed' };
  const previous = readOrganizationDeleteUnknown(target.organizationId);
  if (previous.kind !== 'absent') return { ok: false, reason: 'unknown' };
  // Re-read at explicit submission, never as an effect of navigation. Native
  // approval and execution still revalidate every write operand independently.
  const current = await loadOrganizationDeletion(target.organizationId, read);
  if (current.kind !== 'ready') return { ok: false, reason: current.kind === 'unavailable' ? 'unavailable' : 'denied' };
  if (
    current.target.humanAccountId !== target.humanAccountId ||
    current.target.handle !== target.handle ||
    current.target.displayName !== target.displayName
  )
    return { ok: false, reason: 'changed' };
  const expected = accountOperationProfile('delete');
  if (
    current.target.session.clientId !== expected.client_id ||
    current.target.session.scopes?.length !== 1 ||
    current.target.session.scopes[0] !== expected.scope[0]
  )
    return { ok: false, reason: 'step-up' };
  // Persist a minimal uncertainty fence before sending. A crash or reload cannot
  // turn a lost response into a new approval. It contains no bearer or reference.
  const identity = {
    version: 1 as const,
    operation: 'delete' as const,
    humanAccountId: target.humanAccountId,
    organizationId: target.organizationId,
    operationKey,
    returnTo: organizationDeleteReturnTo,
  };
  try {
    storeOrganizationDeleteUnknown(identity);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const result = await runAccountOperation(operationKey, { kind: 'delete', accountId: target.organizationId });
  if (result.ok || result.reason !== 'unknown') {
    clearOrganizationDeleteUnknown(target.organizationId);
  }
  return result;
}
