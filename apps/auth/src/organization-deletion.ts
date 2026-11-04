import { authPost } from './api';
import { runAccountOperation, type AccountOperationResult } from './account-operations';
import {
  isAccountId,
  readOrganizationDeleteUnknown,
  readOrganizationDeleteStepUp,
  organizationDeletePendingMatches,
  storeOrganizationDeleteUnknown,
  clearOrganizationDeleteUnknown,
  organizationDeleteReturnTo,
} from './organization-delete-step-up';

// One issuer observation binds the viewer and any privately admitted identity.
// Browser selection and retained continuations grant no authority.
export type OrganizationDeletionRead =
  | {
      kind: 'ready';
      humanAccountId: string;
      action: 'confirm';
      account: { id: string; kind: 'organization'; handle: string | null; displayName: string | null };
    }
  | { kind: 'authentication-required'; humanAccountId: string; action: 'authenticate' }
  | { kind: 'signed-out' | 'hidden' | 'denied' | 'missing' | 'changed' | 'unavailable' };
export type OrganizationDeletionReader = (input: { organizationId: string }) => Promise<OrganizationDeletionRead>;

export const readCurrentOrganizationForDeletion: OrganizationDeletionReader = async ({ organizationId }) => {
  const result = await authPost('/account-management/organizations/deletion-review', { organizationId });
  if (!result.ok) return { kind: 'unavailable' };
  const body = result.body;
  if (!body || typeof body !== 'object' || !('kind' in body)) return { kind: 'unavailable' };
  const keys = Object.keys(body).sort().join(',');
  if (
    keys === 'kind' &&
    ['signed-out', 'hidden', 'denied', 'missing', 'changed', 'unavailable'].includes(String(body.kind))
  )
    return { kind: body.kind } as OrganizationDeletionRead;
  if (!('humanAccountId' in body) || !isAccountId(body.humanAccountId) || body.humanAccountId === organizationId)
    return { kind: 'unavailable' };
  if (
    keys === 'action,humanAccountId,kind' &&
    body.kind === 'authentication-required' &&
    'action' in body &&
    body.action === 'authenticate'
  )
    return { kind: 'authentication-required', humanAccountId: body.humanAccountId, action: 'authenticate' };
  if (
    keys !== 'account,action,humanAccountId,kind' ||
    body.kind !== 'ready' ||
    !('action' in body) ||
    body.action !== 'confirm' ||
    !('account' in body) ||
    !body.account ||
    typeof body.account !== 'object'
  )
    return { kind: 'unavailable' };
  const row = body.account;
  if (
    Object.keys(row).sort().join(',') !== 'displayName,handle,id,kind' ||
    !('id' in row) ||
    row.id !== organizationId ||
    !('kind' in row) ||
    row.kind !== 'organization' ||
    !('handle' in row) ||
    (row.handle !== null && typeof row.handle !== 'string') ||
    !('displayName' in row) ||
    (row.displayName !== null && typeof row.displayName !== 'string')
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    humanAccountId: body.humanAccountId,
    action: 'confirm',
    account: { id: organizationId, kind: 'organization', handle: row.handle, displayName: row.displayName },
  };
};

export type OrganizationDeletionTarget = {
  humanAccountId: string;
  organizationId: string;
  handle: string | null;
  displayName: string | null;
};
export type OrganizationDeletionLoad =
  | { kind: 'ready'; target: OrganizationDeletionTarget }
  | { kind: 'authentication-required'; humanAccountId: string }
  | { kind: 'signed-out' | 'hidden' | 'denied' | 'missing' | 'changed' | 'unavailable' };

export type OrganizationDeletionReview = {
  humanAccountId?: string | undefined;
  isCurrent: () => boolean;
  onExecutionDispatch?: (() => boolean) | undefined;
};

export async function loadOrganizationDeletion(
  organizationId: string,
  read: OrganizationDeletionReader = readCurrentOrganizationForDeletion,
  review?: OrganizationDeletionReview,
): Promise<OrganizationDeletionLoad> {
  if (review && !review.isCurrent()) return { kind: 'unavailable' };
  if (!isAccountId(organizationId)) return { kind: 'missing' };
  try {
    const result = await read({ organizationId });
    if (review && !review.isCurrent()) return { kind: 'unavailable' };
    if (result.kind !== 'ready' && result.kind !== 'authentication-required') return result;
    if (!isAccountId(result.humanAccountId) || result.humanAccountId === organizationId) return { kind: 'denied' };
    if (review?.humanAccountId && review.humanAccountId !== result.humanAccountId) return { kind: 'changed' };
    if (review) review.humanAccountId = result.humanAccountId;
    if (result.kind === 'authentication-required') return { kind: result.kind, humanAccountId: result.humanAccountId };
    if (result.account.id !== organizationId || result.account.kind !== 'organization') return { kind: 'denied' };
    return {
      kind: 'ready',
      target: {
        humanAccountId: result.humanAccountId,
        organizationId,
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
  review?: OrganizationDeletionReview,
): Promise<AccountOperationResult | { ok: false; reason: 'changed' }> {
  if (!/^[a-f0-9]{32}$/.test(operationKey)) return { ok: false, reason: 'changed' };
  const previous = readOrganizationDeleteUnknown(target.organizationId);
  if (previous.kind !== 'absent') return { ok: false, reason: 'unknown' };
  // Re-read at explicit submission, never as an effect of navigation. Native
  // approval and execution still revalidate every write operand independently.
  const current = await loadOrganizationDeletion(target.organizationId, read, review);
  if (review && !review.isCurrent()) return { ok: false, reason: 'failure' };
  if (current.kind === 'authentication-required')
    return { ok: false, reason: current.humanAccountId === target.humanAccountId ? 'step-up' : 'changed' };
  if (current.kind !== 'ready')
    return {
      ok: false,
      reason: current.kind === 'unavailable' ? 'unavailable' : current.kind === 'changed' ? 'changed' : 'denied',
    };
  if (
    current.target.humanAccountId !== target.humanAccountId ||
    current.target.handle !== target.handle ||
    current.target.displayName !== target.displayName
  )
    return { ok: false, reason: 'changed' };
  // Released review I/O cannot replace an existing operation or unknown result.
  if (readOrganizationDeleteUnknown(target.organizationId).kind !== 'absent') return { ok: false, reason: 'unknown' };
  const continuation = readOrganizationDeleteStepUp();
  if (
    continuation.kind === 'invalid' ||
    (continuation.kind === 'pending' &&
      !organizationDeletePendingMatches(continuation.value, target.humanAccountId, target.organizationId, operationKey))
  )
    return { ok: false, reason: 'changed' };
  // Persist the fence at the execution boundary, after approval and immediately
  // before sending. A preflight or approval failure is not a submitted deletion.
  const identity = {
    version: 1 as const,
    operation: 'delete' as const,
    humanAccountId: target.humanAccountId,
    organizationId: target.organizationId,
    operationKey,
    returnTo: organizationDeleteReturnTo,
  };
  let fenceUnavailable = false;
  let fenceConflict = false;
  let fenceStored = false;
  const clearFence = () => {
    const saved = readOrganizationDeleteUnknown(target.organizationId);
    if (
      saved.kind === 'pending' &&
      organizationDeletePendingMatches(saved.value, target.humanAccountId, target.organizationId, operationKey)
    )
      clearOrganizationDeleteUnknown(target.organizationId);
  };
  const onExecutionDispatch = () => {
    if (review && !review.isCurrent()) return false;
    const saved = readOrganizationDeleteUnknown(target.organizationId);
    if (saved.kind !== 'absent') {
      // The installed executor can make one bounded same-key retry after an
      // unavailable execution response. Only this call's exact fence may cross
      // that second dispatch; restored or concurrent uncertainty stays read-only.
      if (
        !fenceStored ||
        saved.kind !== 'pending' ||
        !organizationDeletePendingMatches(saved.value, target.humanAccountId, target.organizationId, operationKey)
      ) {
        fenceConflict = true;
        return false;
      }
      return !review?.onExecutionDispatch || review.onExecutionDispatch();
    }
    try {
      storeOrganizationDeleteUnknown(identity);
      const stored = readOrganizationDeleteUnknown(target.organizationId);
      if (
        stored.kind !== 'pending' ||
        !organizationDeletePendingMatches(stored.value, target.humanAccountId, target.organizationId, operationKey)
      ) {
        fenceUnavailable = true;
        return false;
      }
      fenceStored = true;
    } catch {
      fenceUnavailable = true;
      return false;
    }
    if (review?.onExecutionDispatch && !review.onExecutionDispatch()) {
      clearFence();
      return false;
    }
    return true;
  };
  const result = await runAccountOperation(
    operationKey,
    { kind: 'delete', accountId: target.organizationId },
    { isCurrent: () => !review || review.isCurrent(), retryUncertain: true, onExecutionDispatch },
  );
  if (fenceUnavailable) {
    clearFence();
    return { ok: false, reason: 'unavailable' };
  }
  if (fenceConflict) return { ok: false, reason: 'unknown' };
  // A response from this exact attempt may settle its own fence after departure.
  // It cannot replace a newer view or settle any earlier unknown attempt.
  if (review && !review.isCurrent()) {
    if (result.ok || result.reason !== 'unknown') clearFence();
    return result;
  }
  if (result.ok || result.reason !== 'unknown') {
    clearOrganizationDeleteUnknown(target.organizationId);
  }
  return result;
}
