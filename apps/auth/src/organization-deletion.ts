import {
  ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH,
  ORGANIZATION_DELETION_MAX_HANDLE_LENGTH,
  ORGANIZATION_DELETION_MAX_RESPONSE_BYTES,
  type OrganizationDeletionResponse,
} from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { privateAuthRead } from './private-auth-read';
import { runAccountOperation, type AccountOperationResult } from './account-operations';
import {
  isAccountId,
  readOrganizationDeleteUnknown,
  readOrganizationDeleteStepUp,
  organizationDeletePendingMatches,
  storeOrganizationDeleteUnknown,
  clearOrganizationDeleteUnknown,
  organizationDeleteReturnTo,
  sameOrganizationDeleteDescriptor,
} from './organization-delete-step-up';

// One issuer observation binds the viewer and any privately admitted identity.
// Browser selection and retained continuations grant no authority.
export type OrganizationDeletionRead = OrganizationDeletionResponse;
export type OrganizationDeletionReader = (input: {
  organizationId: string;
  signal?: AbortSignal | undefined;
}) => Promise<OrganizationDeletionRead>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOrganizationDeletionResponse(body: unknown, organizationId: string): OrganizationDeletionRead {
  if (!record(body)) return { kind: 'unavailable' };
  const keys = Object.keys(body).sort().join(',');
  if (keys === 'kind') {
    switch (body.kind) {
      case 'signed-out':
      case 'hidden':
      case 'denied':
      case 'missing':
      case 'changed':
      case 'unavailable':
        return { kind: body.kind };
    }
  }
  if (!('humanAccountId' in body) || !isAccountId(body.humanAccountId) || body.humanAccountId === organizationId)
    return { kind: 'unavailable' };
  if (
    keys === 'action,humanAccountId,kind' &&
    body.kind === 'authentication-required' &&
    body.action === 'authenticate'
  )
    return { kind: 'authentication-required', humanAccountId: body.humanAccountId, action: 'authenticate' };
  if (
    keys !== 'account,action,humanAccountId,kind' ||
    body.kind !== 'ready' ||
    body.action !== 'confirm' ||
    !record(body.account)
  )
    return { kind: 'unavailable' };
  const account = body.account;
  if (
    Object.keys(account).sort().join(',') !== 'displayName,handle,id,kind' ||
    account.id !== organizationId ||
    account.kind !== 'organization' ||
    (account.handle !== null &&
      (typeof account.handle !== 'string' ||
        account.handle.length > ORGANIZATION_DELETION_MAX_HANDLE_LENGTH ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account.handle))) ||
    (account.displayName !== null &&
      (typeof account.displayName !== 'string' ||
        account.displayName.length > ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH))
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    humanAccountId: body.humanAccountId,
    action: 'confirm',
    account: {
      id: organizationId,
      kind: 'organization',
      handle: account.handle as string | null,
      displayName: account.displayName as string | null,
    },
  };
}

export const readCurrentOrganizationForDeletion: OrganizationDeletionReader = async ({ organizationId, signal }) => {
  try {
    return await privateAuthRead(async (readSignal) => {
      const response = await fetch('/account-management/organizations/deletion-review', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
        signal: readSignal,
      });
      // Read bounded actual bytes for both success and error responses before
      // classifying status. This same signal owns fetch and streamed JSON.
      const body = await readJsonBounded(response, ORGANIZATION_DELETION_MAX_RESPONSE_BYTES, readSignal);
      if (response.status !== 200) return { kind: 'unavailable' };
      return parseOrganizationDeletionResponse(body, organizationId);
    }, signal);
  } catch {
    return { kind: 'unavailable' };
  }
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
  signal?: AbortSignal | undefined;
  onExecutionDispatch?: (() => boolean) | undefined;
};

export async function loadOrganizationDeletion(
  organizationId: string,
  read: OrganizationDeletionReader = readCurrentOrganizationForDeletion,
  review?: OrganizationDeletionReview,
): Promise<OrganizationDeletionLoad> {
  if (review && (!review.isCurrent() || review.signal?.aborted)) return { kind: 'unavailable' };
  if (!isAccountId(organizationId)) return { kind: 'missing' };
  try {
    const result = await read({ organizationId, signal: review?.signal });
    if (review && (!review.isCurrent() || review.signal?.aborted)) return { kind: 'unavailable' };
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
  const expectedContinuation = continuation.kind === 'pending' ? continuation.value : null;
  const continuationIsCurrent = () => {
    const latest = readOrganizationDeleteStepUp();
    return expectedContinuation === null
      ? latest.kind === 'absent'
      : latest.kind === 'pending' && sameOrganizationDeleteDescriptor(latest.value, expectedContinuation);
  };
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
  let fenceMayHaveBeenSubmitted = false;
  let continuationChanged = false;
  const clearFence = () => {
    const saved = readOrganizationDeleteUnknown(target.organizationId);
    if (saved.kind === 'pending' && sameOrganizationDeleteDescriptor(saved.value, identity))
      clearOrganizationDeleteUnknown(target.organizationId, identity);
  };
  const onExecutionDispatch = () => {
    if (review && !review.isCurrent()) return false;
    if (!continuationIsCurrent()) {
      continuationChanged = true;
      return false;
    }
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
      if (review?.onExecutionDispatch && !review.onExecutionDispatch()) return false;
      fenceMayHaveBeenSubmitted = true;
      return true;
    }
    try {
      if (!storeOrganizationDeleteUnknown(identity)) {
        fenceUnavailable = true;
        return false;
      }
      const stored = readOrganizationDeleteUnknown(target.organizationId);
      if (stored.kind !== 'pending' || !sameOrganizationDeleteDescriptor(stored.value, identity)) {
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
    fenceMayHaveBeenSubmitted = true;
    return true;
  };
  const result = await runAccountOperation(
    operationKey,
    { kind: 'delete', accountId: target.organizationId },
    { isCurrent: () => !review || review.isCurrent(), retryUncertain: true, onExecutionDispatch },
  );
  if (continuationChanged && !fenceMayHaveBeenSubmitted) return { ok: false, reason: 'changed' };
  if (fenceUnavailable) {
    // Persistence may have committed before reporting failure. Keep both the
    // durable marker (if present) and the caller's exact in-memory custody.
    return { ok: false, reason: 'unknown' };
  }
  if (fenceConflict) return { ok: false, reason: 'unknown' };
  if (fenceMayHaveBeenSubmitted && !result.ok && result.reason !== 'unknown') return { ok: false, reason: 'unknown' };
  // A response from this exact attempt may settle its own fence after departure.
  // It cannot replace a newer view or settle any earlier unknown attempt.
  if (review && !review.isCurrent()) {
    if (result.ok || !fenceMayHaveBeenSubmitted) clearFence();
    return result;
  }
  if (result.ok || !fenceMayHaveBeenSubmitted) {
    clearOrganizationDeleteUnknown(target.organizationId, identity);
  }
  return result;
}
