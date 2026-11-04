import { authPost, type AuthPostResult } from './api';
import { loadAccountSession, type AccountSessionResult } from './account-operations';
import { managementOperationProfile } from '@rezics/auth-contract';
import {
  requestOperatorTransferPage,
  type OperatorTransferPageInput,
  type OperatorTransferPageResponse,
} from './operator-transfer-page';

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
  | {
      kind: 'acknowledged';
      reference: string;
      readback: { kind: 'current'; relation: OperatorRelation } | TransferFailure;
    }
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
  return null;
}
function exactFields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function pageResponse(value: unknown): value is OperatorTransferPageResponse {
  if (!record(value) || !exactFields(value, ['viewer', 'review']) || !record(value.viewer) || !record(value.review))
    return false;
  const { viewer, review } = value;
  if (viewer.kind === 'ready' && !exactFields(viewer, ['kind'])) return false;
  else if (
    viewer.kind === 'authentication-required' &&
    (!exactFields(viewer, ['kind', 'continuation']) || viewer.continuation !== 'operator-transfer')
  )
    return false;
  else if (viewer.kind === 'signed-out' && !exactFields(viewer, ['kind'])) return false;
  else if (viewer.kind === 'refused' && !exactFields(viewer, ['kind'])) return false;
  else if (!['ready', 'authentication-required', 'signed-out', 'refused'].includes(String(viewer.kind))) return false;
  if (review.kind === 'readiness') return exactFields(review, ['kind']);
  if (['missing', 'refused', 'changed', 'unavailable'].includes(String(review.kind)))
    return exactFields(review, ['kind']);
  if (review.kind === 'source') {
    if (!exactFields(review, ['kind', 'relation', 'action']) || review.action !== 'allowed' || !record(review.relation))
      return false;
    const relation = review.relation;
    return exactFields(relation, ['previous', 'expectedVersion']) && isRelation(relation);
  }
  if (review.kind === 'destination')
    return (
      exactFields(review, ['kind', 'destinationAccountId', 'action']) &&
      text(review.destinationAccountId) &&
      ['allowed', 'denied'].includes(String(review.action))
    );
  return false;
}
export function pageFailure(page: OperatorTransferPageResponse): TransferFailure | null {
  if (page.viewer.kind === 'authentication-required') return { kind: 'failure', reason: 'step-up' };
  if (page.viewer.kind === 'signed-out') return { kind: 'failure', reason: 'denied' };
  if (page.viewer.kind === 'refused') return { kind: 'failure', reason: 'denied' };
  return null;
}
export function isTransferFailure(value: OperatorTransferPageResponse | TransferFailure): value is TransferFailure {
  return 'kind' in value && value.kind === 'failure';
}
export async function reviewDestinationTransfer(
  request: TransferRequest,
  accountId: string,
): Promise<TransferFailure | null> {
  const page = await readOperatorTransferPage({ kind: 'destination', request }, accountId);
  if (isTransferFailure(page)) return page;
  const denied = pageFailure(page);
  if (denied) return denied;
  if (
    page.review.kind === 'destination' &&
    page.review.destinationAccountId === request.operatorAccountId &&
    page.review.action === 'allowed'
  )
    return null;
  if (page.review.kind === 'changed') return { kind: 'failure', reason: 'conflict' };
  if (page.review.kind === 'refused' || page.review.kind === 'destination')
    return { kind: 'failure', reason: 'denied' };
  return { kind: 'failure', reason: page.review.kind === 'missing' ? 'invalid' : 'unavailable' };
}
export async function refreshTransferAdvice(attempt: TransferAttempt): Promise<TransferFailure | null> {
  const input: OperatorTransferPageInput =
    attempt.side === 'source'
      ? { kind: 'source', subjectAccountId: attempt.request.previous.subjectAccountId }
      : { kind: 'destination', request: attempt.request };
  const page = await readOperatorTransferPage(input, attempt.accountId);
  if (isTransferFailure(page)) return page;
  const denied = pageFailure(page);
  if (denied) return denied;
  if (attempt.side === 'source') {
    if (page.review.kind === 'source' && sameRelation(page.review.relation, attempt.request)) return null;
    if (page.review.kind === 'refused') return { kind: 'failure', reason: 'denied' };
    if (page.review.kind === 'changed' || page.review.kind === 'missing')
      return { kind: 'failure', reason: 'conflict' };
    if (page.review.kind === 'source') return { kind: 'failure', reason: 'conflict' };
    return { kind: 'failure', reason: 'unavailable' };
  }
  if (
    page.review.kind === 'destination' &&
    page.review.destinationAccountId === attempt.request.operatorAccountId &&
    page.review.action === 'allowed'
  )
    return null;
  if (page.review.kind === 'refused' || page.review.kind === 'destination')
    return { kind: 'failure', reason: 'denied' };
  return { kind: 'failure', reason: page.review.kind === 'changed' ? 'conflict' : 'unavailable' };
}
export async function readOperatorTransferPage(
  input: OperatorTransferPageInput,
  accountId?: string,
): Promise<OperatorTransferPageResponse | TransferFailure> {
  if (accountId) {
    const denied = await boundSession(accountId);
    if (denied) return denied;
  }
  const result = await requestOperatorTransferPage(input);
  if (!result.ok) return failure(result);
  if (!pageResponse(result.body)) return { kind: 'failure', reason: 'unavailable' };
  if (
    (input.kind === 'readiness' && result.body.viewer.kind === 'ready' && result.body.review.kind !== 'readiness') ||
    (input.kind === 'source' &&
      result.body.review.kind === 'source' &&
      result.body.review.relation.previous.subjectAccountId !== input.subjectAccountId) ||
    (input.kind === 'destination' &&
      result.body.review.kind === 'destination' &&
      result.body.review.destinationAccountId !== input.request.operatorAccountId)
  )
    return { kind: 'failure', reason: 'unavailable' };
  return result.body;
}
export async function readOperatorRelation(subjectAccountId: string, accountId: string): Promise<RelationResult> {
  const result = await readOperatorTransferPage({ kind: 'source', subjectAccountId }, accountId);
  if (isTransferFailure(result)) return result;
  const denied = pageFailure(result);
  if (denied) return denied;
  if (result.review.kind === 'source' && result.review.relation.previous.subjectAccountId === subjectAccountId)
    return { kind: 'ready', relation: result.review.relation };
  return {
    kind: 'failure',
    reason:
      result.review.kind === 'changed' || result.review.kind === 'missing'
        ? 'conflict'
        : result.review.kind === 'refused'
          ? 'denied'
          : 'unavailable',
  };
}
export async function prepareTransfer(
  subjectAccountId: string,
  operatorAccountId: string,
  accountId: string,
): Promise<TransferRequest | TransferFailure> {
  if (!text(subjectAccountId) || !text(operatorAccountId)) return { kind: 'failure', reason: 'invalid' };
  const page = await readOperatorTransferPage({ kind: 'source', subjectAccountId }, accountId);
  if (isTransferFailure(page)) return page;
  const denied = pageFailure(page);
  if (denied) return denied;
  if (page.review.kind !== 'source')
    return {
      kind: 'failure',
      reason:
        page.review.kind === 'missing' || page.review.kind === 'changed'
          ? 'conflict'
          : page.review.kind === 'refused'
            ? 'denied'
            : 'unavailable',
    };
  const current = page.review.relation;
  const request = {
    ...current,
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
    const advice = await refreshTransferAdvice(attempt);
    if (advice) return advice;
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
  if (current.kind !== 'ready') return { kind: 'acknowledged', reference: attempt.reference!, readback: current };
  // An acknowledgement never substitutes for this independently authorized read.
  if (
    current.relation.previous.operatorAccountId !== request.operatorAccountId ||
    BigInt(current.relation.expectedVersion) <= BigInt(request.expectedVersion) ||
    current.relation.previous.reservationId === request.previous.reservationId
  )
    return {
      kind: 'acknowledged',
      reference: attempt.reference!,
      readback: { kind: 'failure', reason: 'conflict' },
    };
  return {
    kind: 'acknowledged',
    reference: attempt.reference!,
    readback: { kind: 'current', relation: current.relation },
  };
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
