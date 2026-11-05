import { createServerFn } from '@tanstack/react-start';
import {
  ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES,
  parseAccountOperationApprovalResponse,
  parseAccountOperationRefusal,
  securityResponseLimits,
} from '@rezics/auth-contract';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';
import {
  isManagementOperation,
  managementOperationProfile,
  type ManagementOperationInput,
  type ManagementOperationResult,
  type ManagementSession,
  type ManagementSessionResult,
} from '@rezics/auth-contract';
import { authPost, authPostBounded, type AuthPostResult, type BoundedAuthPostResult } from './api';
import {
  pendingManagementOperationMatches,
  pendingManagementOperationStepUpState,
} from './management-operation-step-up';
import { readSecurityIssuerResponse, trustedSecurityResponseConfiguration } from './security-response-config';

export {
  managementOperationProfile,
  type ManagementOperation,
  type ManagementOperationInput,
  type ManagementOperationResult,
  type ManagementSession,
  type ManagementSessionResult,
} from '@rezics/auth-contract';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseManagementSession(body: unknown, scopeLimit: number): ManagementSessionResult {
  if (
    !record(body) ||
    Object.keys(body).some(
      (key) => !['account_id', 'client_id', 'scope', 'authn_epoch', 'auth_time', 'amr'].includes(key),
    ) ||
    typeof body.account_id !== 'string' ||
    !body.account_id ||
    body.account_id.length > securityResponseLimits.id ||
    typeof body.client_id !== 'string' ||
    !body.client_id ||
    body.client_id.length > securityResponseLimits.id ||
    !Array.isArray(body.scope) ||
    body.scope.length > scopeLimit ||
    !body.scope.every((scope) => typeof scope === 'string' && scope.length <= securityResponseLimits.scope) ||
    !Number.isSafeInteger(body.authn_epoch) ||
    (body.authn_epoch as number) < 0 ||
    !Number.isSafeInteger(body.auth_time) ||
    (body.auth_time as number) < 0 ||
    (body.auth_time as number) > Math.floor(Date.now() / 1000) ||
    !Array.isArray(body.amr) ||
    body.amr.length !== 1 ||
    (body.amr[0] !== 'pwd' && body.amr[0] !== 'pop')
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    accountId: body.account_id,
    clientId: body.client_id,
    scopes: body.scope as string[],
    authTime: body.auth_time as number,
    authnEpoch: body.authn_epoch as number,
    amr: body.amr as ('pwd' | 'pop')[],
  };
}

const readManagementSession = createServerFn({ method: 'POST' }).handler(async (): Promise<ManagementSessionResult> => {
  const configuration = await trustedSecurityResponseConfiguration();
  if (!configuration) return { kind: 'unavailable' };
  return readSecurityIssuerResponse('/session', undefined, async (response, signal) => {
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status !== 200) return { kind: 'unavailable' };
    const body = await readJsonBounded(response, configuration.sessionBytes, signal);
    return parseManagementSession(body, configuration.scopeLimit);
  });
});

/** Reads the full native human proof for advice; native approval remains authoritative. */
export async function loadManagementSession(signal?: AbortSignal): Promise<ManagementSessionResult> {
  try {
    return await privateAuthRead((readSignal) => readManagementSession({ signal: readSignal }), signal);
  } catch {
    return { kind: 'unavailable' };
  }
}

export function managementProfileSessionMatches(
  session: ManagementSession,
  kind: ManagementOperationInput['operation']['kind'],
  accountId: string,
): boolean {
  const profile = managementOperationProfile(kind);
  return (
    session.accountId === accountId &&
    session.clientId === profile.client_id &&
    session.scopes.length === profile.scope.length &&
    session.scopes.every((scope, index) => scope === profile.scope[index]) &&
    Date.now() / 1000 - session.authTime <= 600
  );
}
export function managementSessionMatches(session: ManagementSession, input: ManagementOperationInput): boolean {
  return managementProfileSessionMatches(session, input.operation.kind, input.accountId);
}

function failure(
  result: Exclude<AuthPostResult, { ok: true }>,
): Exclude<ManagementOperationResult, { kind: 'complete' }> {
  if (result.status === 401 && result.code === 'step_up_required') return { kind: 'step-up' };
  if ([400, 401, 403, 409, 413, 415].includes(result.status) && result.code === 'account_operation_denied')
    return { kind: 'refused' };
  return { kind: 'unavailable' };
}

function approvalFailure(result: Exclude<BoundedAuthPostResult, { ok: true }>): Exclude<ManagementApprovalResult, { kind: 'approved' }> {
  const refusal = parseAccountOperationRefusal(result.body, result.status);
  if (refusal?.error === 'step_up_required') return { kind: 'step-up' };
  if (refusal?.error === 'account_operation_denied') return { kind: 'refused' };
  return { kind: 'unavailable' };
}

type ManagementApprovalResult =
  | { kind: 'approved'; input: ManagementOperationInput; reference: string; expiresAt: string }
  | Exclude<ManagementOperationResult, { kind: 'complete' }>;

/** Shared closed approval stage. Opening selects its dedicated issuance path;
 * all caller, continuation, freshness and native approval checks stay here. */
export async function approveManagementOperation(
  input: ManagementOperationInput,
  path: 'mutation' | 'opening' = 'mutation',
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<ManagementApprovalResult> {
  if (!isCurrent()) return { kind: 'unavailable' };
  let snapshot: ManagementOperationInput;
  try {
    snapshot = JSON.parse(JSON.stringify(input)) as ManagementOperationInput;
  } catch {
    return { kind: 'refused' };
  }
  if (
    !snapshot ||
    Object.keys(snapshot).some((key) => !['operationKey', 'operation', 'accountId'].includes(key)) ||
    typeof snapshot.operationKey !== 'string' ||
    !snapshot.operationKey ||
    snapshot.operationKey.length > 4096 ||
    typeof snapshot.accountId !== 'string' ||
    !snapshot.accountId ||
    !isManagementOperation(snapshot.operation) ||
    (snapshot.operation.kind === 'opening') !== (path === 'opening')
  )
    return { kind: 'refused' };
  const continuation = pendingManagementOperationStepUpState();
  if (
    continuation.kind === 'invalid' ||
    (continuation.kind === 'pending' &&
      (!pendingManagementOperationMatches(continuation.value, snapshot) || continuation.value.phase !== 'returned'))
  )
    return { kind: 'refused' };
  const current = await loadManagementSession(signal);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (current.kind === 'unavailable') return { kind: 'unavailable' };
  if (current.kind === 'signed-out') return { kind: 'step-up' };
  if (current.accountId !== snapshot.accountId) return { kind: 'refused' };
  if (!managementSessionMatches(current, snapshot)) return { kind: 'step-up' };

  if (path === 'opening') {
    const approved = await authPostBounded(
      '/account-operations/approve',
      snapshot,
      ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES,
      signal,
    );
    if (!isCurrent()) return { kind: 'unavailable' };
    if (!approved.ok) return approvalFailure(approved);
    const approval = parseAccountOperationApprovalResponse(approved.body);
    if (!approval || Date.parse(approval.expiresAt) <= Date.now()) return { kind: 'unavailable' };
    return { kind: 'approved', input: snapshot, reference: approval.reference, expiresAt: approval.expiresAt };
  }

  const approved = await authPost('/account-operations/approve', snapshot);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (!approved.ok) return failure(approved);
  const approval = approved.body;
  if (
    !record(approval) ||
    Object.keys(approval).sort().join(',') !== 'expiresAt,reference' ||
    typeof approval.reference !== 'string' ||
    !approval.reference ||
    approval.reference.length > 4096 ||
    typeof approval.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(approval.expiresAt)) ||
    Date.parse(approval.expiresAt) <= Date.now()
  )
    return { kind: 'unavailable' };
  return { kind: 'approved', input: snapshot, reference: approval.reference, expiresAt: approval.expiresAt };
}

/** Invoke only from the page's explicit submit, including after a fresh return.
 * The immutable snapshot survives every await and the existing unavailable retry.
 * Completion reports the native operation result, never a later readback claim. */
export async function executeManagementOperation(input: ManagementOperationInput): Promise<ManagementOperationResult> {
  const approval = await approveManagementOperation(input);
  if (approval.kind !== 'approved') return approval;
  const snapshot = approval.input;
  // Also narrows the shared approval result: opening never reaches mutation
  // dispatch, mutation retry or the accountId result parser.
  if (snapshot.operation.kind === 'opening') return { kind: 'refused' };
  if (snapshot.operation.kind === 'transfer-acceptance')
    return {
      kind: 'complete',
      operationKind: 'transfer-acceptance',
      reference: approval.reference,
      expiresAt: approval.expiresAt,
    };

  // Cookie substitution after approval is compared again in the real host against accountId and the exact profile.
  const body = { ...snapshot, reference: approval.reference };
  let executed = await authPost('/account-operations/execute', body);
  const uncertain = !executed.ok && executed.status === 503;
  // A deadline is uncertain native work, never permission to repeat execution.
  if (!executed.ok && executed.status === 503 && executed.code === 'unavailable')
    executed = await authPost('/account-operations/execute', body);
  if (!executed.ok) {
    const outcome = failure(executed);
    return uncertain || outcome.kind === 'unavailable' ? { kind: 'unknown' } : outcome;
  }
  const expectedAccountId =
    snapshot.operation.kind === 'rename'
      ? snapshot.operation.accountId
      : snapshot.operation.kind === 'membership'
        ? snapshot.operation.memberAccountId
        : snapshot.operation.previous.subjectAccountId;
  if (
    !record(executed.body) ||
    Object.keys(executed.body).join(',') !== 'accountId' ||
    executed.body.accountId !== expectedAccountId
  )
    return { kind: 'unknown' };
  return { kind: 'complete', operationKind: snapshot.operation.kind, accountId: expectedAccountId };
}
