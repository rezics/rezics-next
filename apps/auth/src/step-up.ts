import { authPost, failureMessage } from './api';
import {
  selectOrganizationDeleteStepUp,
  organizationDeleteSessionMatches,
  organizationDeletePendingMatches,
} from './organization-delete-step-up';
import { loadAccountSession } from './account-operations';
import {
  accountOperationSessionMatches,
  selectAccountOperationStepUp,
  pendingAccountOperationMatches,
} from './account-operation-step-up';
import { passkeySignInFailure, signInWithPasskey } from './passkeys';
import { signIn, signInForAccountOperation, signInTarget, signInResult, type SignInResult } from './sign-in';
import { m } from './paraglide/messages.js';
import { loadManagementSession, managementOperationProfile, managementSessionMatches } from './management-operations';
import {
  markManagementOperationReturned,
  selectManagementOperationStepUp,
  type PendingManagementOperationStepUp,
} from './management-operation-step-up';

async function managementReturn(
  pending: PendingManagementOperationStepUp,
  origin: string,
  isCurrent: () => boolean,
): Promise<StepUpOutcome> {
  const session = await loadManagementSession();
  if (
    !isCurrent() ||
    session.kind !== 'ready' ||
    !managementSessionMatches(session, pending) ||
    !markManagementOperationReturned(pending)
  )
    return { ok: false, message: m.auth_account_operation_failure() };
  return { ok: true, target: new URL(pending.returnTo, origin).href };
}

function selectStepUp(query: string) {
  const organization = selectOrganizationDeleteStepUp(query);
  return organization.kind === 'ordinary' ? selectAccountOperationStepUp(query) : organization;
}

type RetainedSelection = Extract<ReturnType<typeof selectStepUp>, { kind: 'operation' | 'organization-delete' }>;

function retainedSelectionMatches(query: string, selection: RetainedSelection): boolean {
  // Reuse validating readers: absent, malformed or unsupported replacement
  // targets cannot become ordinary navigation after authentication succeeds.
  const current = selectStepUp(query);
  if (selection.kind === 'organization-delete') {
    return (
      current.kind === 'organization-delete' &&
      current.pending.operation === selection.pending.operation &&
      current.pending.returnTo === selection.pending.returnTo &&
      organizationDeletePendingMatches(
        current.pending,
        selection.pending.humanAccountId,
        selection.pending.organizationId,
        selection.pending.operationKey,
      )
    );
  }
  return (
    current.kind === 'operation' &&
    current.pending.returnTo === selection.pending.returnTo &&
    pendingAccountOperationMatches(
      current.pending,
      selection.pending.accountId,
      selection.pending.operationKey,
      selection.pending.operation,
    )
  );
}

async function retainedReturn(
  query: string,
  selection: RetainedSelection,
  origin: string,
  isCurrent: () => boolean,
): Promise<StepUpOutcome> {
  const failure = () => ({ ok: false as const, message: m.auth_step_up_continuation_changed() });
  if (!isCurrent() || !retainedSelectionMatches(query, selection)) return failure();
  const session = await loadAccountSession();
  if (!isCurrent() || !retainedSelectionMatches(query, selection)) return failure();
  if (session.kind === 'failure') return { ok: false, message: m.auth_failure_unavailable() };
  if (
    session.kind !== 'ready' ||
    !(selection.kind === 'organization-delete'
      ? organizationDeleteSessionMatches(session, selection.pending)
      : accountOperationSessionMatches(session, selection.pending))
  )
    return { ok: false, message: m.auth_step_up_account_changed() };
  return { ok: true, target: new URL(selection.pending.returnTo, origin).href };
}

// A null message is a dismissed passkey prompt, which stays silent.
export type StepUpOutcome = { ok: true; target: string } | { ok: false; message: string | null };

// 401, 429 and 503 stay on the page. signIn already collapsed the Auth result to these three outcomes.
export function stepUpFailure(result: Exclude<SignInResult, { ok: true }>): string {
  if (result.reason === 'credentials') return failureMessage(401, 'authentication_denied', null);
  if (result.reason === 'rate-limited') return failureMessage(429, 'rate_limited', result.retryAfter);
  return failureMessage(503, 'unavailable', null);
}

export async function confirmStepUp(
  email: string,
  password: string,
  query: string,
  origin: string,
  isCurrent = () => true,
): Promise<StepUpOutcome> {
  const management = selectManagementOperationStepUp(query);
  if (management.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  if (management.kind === 'management') {
    const result = signInResult(
      await authPost('/signin', { email, password, ...managementOperationProfile(management.pending.kind) }),
    );
    if (!isCurrent()) return { ok: false, message: null };
    if (!result.ok) return { ok: false, message: stepUpFailure(result) };
    return managementReturn(management.pending, origin, isCurrent);
  }
  const selection = selectStepUp(query);
  if (selection.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  const result =
    selection.kind === 'operation' || selection.kind === 'organization-delete'
      ? await signInForAccountOperation(
          email,
          password,
          selection.kind === 'organization-delete' ? 'delete' : selection.pending.kind,
        )
      : await signIn(email, password);
  if (!isCurrent()) return { ok: false, message: null };
  if (!result.ok) return { ok: false, message: stepUpFailure(result) };
  if (selection.kind === 'operation' || selection.kind === 'organization-delete') {
    return retainedReturn(query, selection, origin, isCurrent);
  }
  return { ok: true, target: signInTarget(query, origin) };
}

export async function confirmStepUpWithPasskey(
  query: string,
  origin: string,
  isCurrent = () => true,
): Promise<StepUpOutcome> {
  const management = selectManagementOperationStepUp(query);
  if (management.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  if (management.kind === 'management') {
    const result = await signInWithPasskey({ management: management.pending.kind, isCurrent });
    if (!isCurrent()) return { ok: false, message: null };
    if (result.ok) return managementReturn(management.pending, origin, isCurrent);
    return { ok: false, message: result.reason === 'cancelled' ? null : passkeySignInFailure(result) };
  }
  const selection = selectStepUp(query);
  if (selection.kind === 'invalid') return { ok: false, message: m.auth_account_operation_failure() };
  const result = await signInWithPasskey(
    selection.kind === 'organization-delete'
      ? { operation: 'delete', isCurrent }
      : selection.kind === 'operation'
        ? { operation: selection.pending.kind, isCurrent }
        : { isCurrent },
  );
  if (!isCurrent()) return { ok: false, message: null };
  if (result.ok) {
    if (selection.kind === 'operation' || selection.kind === 'organization-delete') {
      return retainedReturn(query, selection, origin, isCurrent);
    }
    return { ok: true, target: signInTarget(query, origin) };
  }
  if (result.reason === 'cancelled') return { ok: false, message: null };
  return { ok: false, message: passkeySignInFailure(result) };
}
