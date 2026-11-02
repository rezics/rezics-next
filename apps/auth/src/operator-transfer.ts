import { authPost, type AuthPostResult } from './api';
import { loadAccountSession, type AccountSessionResult } from './account-operations';
import { managementOperationProfile } from '@rezics/auth-contract';

// Closed private native source; its tuple/version is never transfer approval.
export const OPERATOR_RELATION_PATH = '/account-management/operators/relation';
export const OPERATOR_MANAGEMENT_PROFILE = managementOperationProfile('transfer');
export type OperatorRelation = {
  previous: { operatorAccountId: string; subjectAccountId: string; reservationId: string };
  expectedVersion: string;
};
export type TransferRequest = OperatorRelation & {
  version: 1;
  operatorAccountId: string;
  sourceOperationKey: string;
};
export type TransferAttempt = {
  accountId: string;
  request: TransferRequest;
  side: 'destination' | 'source';
  acceptance?: string;
  reference?: string;
  phase: 'approve' | 'execute' | 'readback' | 'accepted';
};
export type TransferFailure = {
  kind: 'failure';
  reason: 'step-up' | 'denied' | 'conflict' | 'unavailable' | 'uncertain' | 'account-changed' | 'invalid';
  status?: number;
  code?: string;
};
export type RelationResult = { kind: 'ready'; relation: OperatorRelation } | TransferFailure;
export type TransferResult =
  | { kind: 'accepted'; reference: string }
  | { kind: 'current'; relation: OperatorRelation }
  | TransferFailure;

const storageKey = 'rezics.operator-transfer.attempt';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join(',') === names.sort().join(',');
}
function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
}
function isRelation(value: unknown): value is OperatorRelation & Record<string, unknown> {
  return (
    record(value) &&
    record(value.previous) &&
    fields(value.previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) &&
    text(value.previous.operatorAccountId) &&
    text(value.previous.subjectAccountId) &&
    text(value.previous.reservationId) &&
    value.previous.operatorAccountId !== value.previous.subjectAccountId &&
    typeof value.expectedVersion === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value.expectedVersion)
  );
}
export function parseTransferRequest(input: string): TransferRequest | null {
  if (input.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(input);
    if (
      !record(value) ||
      !fields(value, ['version', 'previous', 'expectedVersion', 'operatorAccountId', 'sourceOperationKey']) ||
      value.version !== 1 ||
      !text(value.operatorAccountId) ||
      !text(value.sourceOperationKey) ||
      !isRelation(value) ||
      value.operatorAccountId === value.previous.operatorAccountId ||
      value.operatorAccountId === value.previous.subjectAccountId
    )
      return null;
    return value as TransferRequest;
  } catch {
    return null;
  }
}
export function sameRelation(left: OperatorRelation, right: OperatorRelation): boolean {
  return (
    left.expectedVersion === right.expectedVersion &&
    left.previous.operatorAccountId === right.previous.operatorAccountId &&
    left.previous.subjectAccountId === right.previous.subjectAccountId &&
    left.previous.reservationId === right.previous.reservationId
  );
}
export function managementSession(
  session: AccountSessionResult,
): session is Extract<AccountSessionResult, { kind: 'ready' }> {
  return (
    session.kind === 'ready' &&
    session.clientId === OPERATOR_MANAGEMENT_PROFILE.client_id &&
    session.scopes?.length === 1 &&
    session.scopes[0] === 'account:manage'
  );
}
function failure(result: Exclude<AuthPostResult, { ok: true }>, mutation = false): TransferFailure {
  return {
    kind: 'failure',
    status: result.status,
    code: result.code,
    reason:
      result.status === 401 && result.code === 'step_up_required'
        ? 'step-up'
        : result.status === 409
          ? 'conflict'
          : [401, 403].includes(result.status)
            ? 'denied'
            : mutation && result.status >= 500
              ? 'uncertain'
              : 'unavailable',
  };
}
async function boundSession(accountId: string): Promise<TransferFailure | null> {
  const session = await loadAccountSession();
  if (session.kind === 'failure') return { kind: 'failure', reason: 'unavailable' };
  if (session.kind !== 'ready' || session.accountId !== accountId)
    return { kind: 'failure', reason: 'account-changed' };
  if (!managementSession(session)) return { kind: 'failure', reason: 'step-up' };
  return null;
}
export async function readOperatorRelation(subjectAccountId: string, accountId: string): Promise<RelationResult> {
  const denied = await boundSession(accountId);
  if (denied) return denied;
  // POST supplies Origin; Auth rechecks the human and native management authority.
  const result = await authPost<unknown>(OPERATOR_RELATION_PATH, { subjectAccountId });
  if (!result.ok) return failure(result);
  if (
    !record(result.body) ||
    !fields(result.body, ['previous', 'expectedVersion']) ||
    !isRelation(result.body) ||
    result.body.previous.subjectAccountId !== subjectAccountId
  )
    return { kind: 'failure', reason: 'unavailable' };
  return { kind: 'ready', relation: result.body };
}
export async function prepareTransfer(
  subjectAccountId: string,
  operatorAccountId: string,
  accountId: string,
): Promise<TransferRequest | TransferFailure> {
  if (!text(subjectAccountId) || !text(operatorAccountId)) return { kind: 'failure', reason: 'invalid' };
  const current = await readOperatorRelation(subjectAccountId, accountId);
  if (current.kind !== 'ready') return current;
  const request = {
    ...current.relation,
    version: 1 as const,
    operatorAccountId,
    sourceOperationKey: crypto.randomUUID(),
  };
  return parseTransferRequest(JSON.stringify(request)) ?? { kind: 'failure', reason: 'invalid' };
}
function isAttempt(value: unknown): value is TransferAttempt {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['accountId', 'request', 'side', 'acceptance', 'reference', 'phase'].includes(key),
    ) ||
    !text(value.accountId) ||
    !parseTransferRequest(JSON.stringify(value.request)) ||
    !['destination', 'source'].includes(String(value.side)) ||
    !['approve', 'execute', 'readback', 'accepted'].includes(String(value.phase))
  )
    return false;
  if (
    value.side === 'source'
      ? (value.acceptance !== undefined && !text(value.acceptance, 4096)) ||
        (value.phase !== 'approve' && !text(value.acceptance, 4096))
      : value.acceptance !== undefined
  )
    return false;
  if (value.reference !== undefined && !text(value.reference, 4096)) return false;
  return value.side === 'destination'
    ? value.phase === 'approve' || (value.phase === 'accepted' && text(value.reference, 4096))
    : value.phase === 'approve' ||
        (['execute', 'readback'].includes(String(value.phase)) && text(value.reference, 4096));
}
export function storeTransferAttempt(attempt: TransferAttempt): boolean {
  if (!isAttempt(attempt)) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    return true;
  } catch {
    return false;
  }
}
export function restoreTransferAttempt(): TransferAttempt | null | 'invalid' {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return isAttempt(value) ? value : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Explicit submit only. Saved references are opaque locators, never assertions
 * of authority. Native approve/resolve recheck each initiating human, assignment,
 * floor, exact scopes, current relationship/version and both approvals. */
export async function submitTransferAttempt(
  attempt: TransferAttempt,
  save: (attempt: TransferAttempt) => boolean = storeTransferAttempt,
  isCurrent: () => boolean = () => true,
): Promise<TransferResult> {
  if (!isAttempt(attempt) || (attempt.side === 'source' && !text(attempt.acceptance, 4096)))
    return { kind: 'failure', reason: 'invalid' };
  const denied = await boundSession(attempt.accountId);
  if (denied) return denied;
  if (!save(attempt)) return { kind: 'failure', reason: 'unavailable' };
  const { request } = attempt;
  if (attempt.phase === 'accepted') return { kind: 'accepted', reference: attempt.reference! };
  const operation =
    attempt.side === 'destination'
      ? {
          kind: 'transfer-acceptance',
          previous: request.previous,
          expectedVersion: request.expectedVersion,
          operatorAccountId: request.operatorAccountId,
          sourceOperationKey: request.sourceOperationKey,
        }
      : {
          kind: 'transfer',
          previous: request.previous,
          expectedVersion: request.expectedVersion,
          operatorAccountId: request.operatorAccountId,
          acceptance: attempt.acceptance!,
        };
  if (attempt.phase === 'approve') {
    const current = await readOperatorRelation(request.previous.subjectAccountId, attempt.accountId);
    if (current.kind !== 'ready') return current;
    if (!sameRelation(current.relation, request)) return { kind: 'failure', reason: 'conflict' };
    if (!isCurrent()) return { kind: 'failure', reason: 'unavailable' };
    const approved = await authPost<unknown>('/account-operations/approve', {
      operationKey: request.sourceOperationKey,
      operation,
    });
    if (!isCurrent()) return { kind: 'failure', reason: 'uncertain' };
    if (!approved.ok) return failure(approved, true);
    if (
      !record(approved.body) ||
      !fields(approved.body, ['reference', 'expiresAt']) ||
      !text(approved.body.reference, 4096) ||
      typeof approved.body.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(approved.body.expiresAt))
    )
      return { kind: 'failure', reason: 'uncertain' };
    attempt.reference = approved.body.reference;
    attempt.phase = attempt.side === 'destination' ? 'accepted' : 'execute';
    if (!save(attempt)) return { kind: 'failure', reason: 'uncertain' };
    const currentCaller = await boundSession(attempt.accountId);
    if (currentCaller) return currentCaller;
    if (attempt.side === 'destination') return { kind: 'accepted', reference: attempt.reference };
  }
  if (attempt.phase === 'execute') {
    const currentCaller = await boundSession(attempt.accountId);
    if (currentCaller) return currentCaller;
    if (!isCurrent()) return { kind: 'failure', reason: 'unavailable' };
    const executed = await authPost<unknown>('/account-operations/execute', {
      operationKey: request.sourceOperationKey,
      operation,
      reference: attempt.reference,
    });
    if (!executed.ok) return failure(executed, true);
    if (
      !record(executed.body) ||
      executed.body.accountId !== request.previous.subjectAccountId ||
      executed.body.error ||
      executed.body.expired
    )
      return { kind: 'failure', reason: 'uncertain' };
    attempt.phase = 'readback';
    if (!save(attempt)) return { kind: 'failure', reason: 'uncertain' };
  }
  const current = await readOperatorRelation(request.previous.subjectAccountId, attempt.accountId);
  if (current.kind !== 'ready') return current;
  // An acknowledgement never substitutes for this independently authorized read.
  if (
    current.relation.previous.operatorAccountId !== request.operatorAccountId ||
    BigInt(current.relation.expectedVersion) <= BigInt(request.expectedVersion) ||
    current.relation.previous.reservationId === request.previous.reservationId
  )
    return { kind: 'failure', reason: 'uncertain' };
  return { kind: 'current', relation: current.relation };
}

/** Reauthentication stays on the transfer page; there is no return URL. The
 * descriptor/key/ref stay saved and a second, explicit confirmation is required. */
export async function reauthenticateTransfer(
  accountId: string,
  email: string,
  password: string,
  isCurrent: () => boolean = () => true,
): Promise<TransferFailure | null> {
  const current = await loadAccountSession();
  if (current.kind !== 'ready' || current.accountId !== accountId)
    return { kind: 'failure', reason: 'account-changed' };
  if (!isCurrent()) return { kind: 'failure', reason: 'unavailable' };
  const result = await authPost('/signin', { email, password, ...OPERATOR_MANAGEMENT_PROFILE });
  if (!result.ok) return failure(result);
  return boundSession(accountId);
}
