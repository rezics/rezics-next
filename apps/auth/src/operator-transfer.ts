import {
  isOperatorPageVersion,
  TRANSFER_APPROVAL_MAX_RESPONSE_BYTES,
  TRANSFER_MAX_ERROR_BYTES,
  TRANSFER_EXECUTION_MAX_RESPONSE_BYTES,
  parseAccountOperationApproval,
  parseTransferOperationRefusal,
  parseTransferExecution,
} from '@rezics/auth-contract';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';
import { submitSignIn } from './sign-in-transport';
import type { AuthPostResult } from './api';
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
// 4,096 request + 770 accountId + 49,156 source acceptance/reference + 87 outer keys,
// syntax and quoted source/readback enums; six units per UTF-16 unit covers lone-surrogate escaping.
const transferAttemptStorageMaxUnits = 54_109;
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
    isOperatorPageVersion(value.expectedVersion)
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
async function boundSession(accountId: string, signal?: AbortSignal): Promise<TransferFailure | null> {
  const session = await loadAccountSession(signal);
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
  signal?: AbortSignal,
): Promise<TransferFailure | null> {
  const page = await readOperatorTransferPage({ kind: 'destination', request }, accountId, signal);
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
export async function refreshTransferAdvice(
  attempt: TransferAttempt,
  signal?: AbortSignal,
): Promise<TransferFailure | null> {
  const input: OperatorTransferPageInput =
    attempt.side === 'source'
      ? { kind: 'source', subjectAccountId: attempt.request.previous.subjectAccountId }
      : { kind: 'destination', request: attempt.request };
  const page = await readOperatorTransferPage(input, attempt.accountId, signal);
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
  signal?: AbortSignal,
): Promise<OperatorTransferPageResponse | TransferFailure> {
  if (accountId) {
    const denied = await boundSession(accountId, signal);
    if (denied) return denied;
  }
  const result = await requestOperatorTransferPage(input, signal);
  if (!result.ok) return failure(result);
  if (!pageResponse(result.body)) return { kind: 'failure', reason: 'unavailable' };
  if (
    (result.body.viewer.kind !== 'ready' && !['unavailable', 'refused'].includes(result.body.review.kind)) ||
    (input.kind === 'source' && ['destination', 'readiness'].includes(result.body.review.kind)) ||
    (input.kind === 'destination' && ['source', 'readiness'].includes(result.body.review.kind)) ||
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
export async function readOperatorRelation(
  subjectAccountId: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<RelationResult> {
  const result = await readOperatorTransferPage({ kind: 'source', subjectAccountId }, accountId, signal);
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
  signal?: AbortSignal,
): Promise<TransferRequest | TransferFailure> {
  if (!text(subjectAccountId) || !text(operatorAccountId)) return { kind: 'failure', reason: 'invalid' };
  const page = await readOperatorTransferPage({ kind: 'source', subjectAccountId }, accountId, signal);
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
    const raw = JSON.stringify(attempt);
    if (raw.length > transferAttemptStorageMaxUnits) return false;
    window.sessionStorage.setItem(storageKey, raw);
    return true;
  } catch {
    return false;
  }
}
export function restoreTransferAttempt(): TransferAttempt | null | 'invalid' {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    if (raw.length > transferAttemptStorageMaxUnits) return 'invalid';
    const value: unknown = JSON.parse(raw);
    return isAttempt(value) ? value : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** A command owns five seconds through headers and bounded body, even if fetch ignores abort. */
async function transferPost(path: 'approve' | 'execute', body: unknown, caller?: AbortSignal): Promise<AuthPostResult> {
  try {
    return await privateAuthRead(async (signal): Promise<AuthPostResult> => {
      const response = await fetch(`/account-operations/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const value = await readJsonBounded(
        response,
        response.status === 200
          ? path === 'approve'
            ? TRANSFER_APPROVAL_MAX_RESPONSE_BYTES
            : TRANSFER_EXECUTION_MAX_RESPONSE_BYTES
          : TRANSFER_MAX_ERROR_BYTES,
        signal,
      );
      if (response.status === 200) return { ok: true, body: value };
      const code = parseTransferOperationRefusal(value, response.status);
      return code
        ? { ok: false, status: response.status, code, effectStatus: 'not_applied', retryAfter: null }
        : { ok: false, status: 503, code: 'unavailable', retryAfter: null };
    }, caller);
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

/** Explicit submit only. Approval and execution remain independently authorized by native. */
export async function submitTransferAttempt(
  attempt: TransferAttempt,
  save: (attempt: TransferAttempt) => boolean = storeTransferAttempt,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<TransferResult> {
  // Capture the exact command and installed storage, not a mutable phase alias.
  attempt = structuredClone(attempt);
  let retained = JSON.stringify(restoreTransferAttempt());
  const current = () => !signal?.aborted && isCurrent() && JSON.stringify(restoreTransferAttempt()) === retained;
  const unavailable = (): TransferFailure => ({ kind: 'failure', reason: 'unavailable' });
  const uncertain = (): TransferFailure => ({ kind: 'failure', reason: 'uncertain' });
  const persist = (next: TransferAttempt) => {
    if (!current() || !save(next)) return false;
    retained = JSON.stringify(restoreTransferAttempt());
    attempt = next;
    return current();
  };
  if (!current()) return unavailable();
  const denied = await boundSession(attempt.accountId, signal);
  if (!current()) return unavailable();
  if (denied) return denied;
  if (!persist(attempt)) return unavailable();
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
    const advice = await refreshTransferAdvice(attempt, signal);
    if (!current()) return unavailable();
    if (advice) return advice;
    const approved = await transferPost('approve', { operationKey: request.sourceOperationKey, operation }, signal);
    if (!current()) return uncertain();
    if (!approved.ok) return failure(approved, true);
    const approval = parseAccountOperationApproval(approved.body);
    if (!approval || Date.parse(approval.expiresAt) <= Date.now()) return uncertain();
    if (
      !persist({
        ...attempt,
        reference: approval.reference,
        phase: attempt.side === 'destination' ? 'accepted' : 'execute',
      })
    )
      return uncertain();
    const currentCaller = await boundSession(attempt.accountId, signal);
    if (!current()) return uncertain();
    if (currentCaller) return currentCaller;
    if (attempt.side === 'destination') return { kind: 'accepted', reference: attempt.reference! };
  }
  if (attempt.phase === 'execute') {
    const currentCaller = await boundSession(attempt.accountId, signal);
    if (!current()) return unavailable();
    if (currentCaller) return currentCaller;
    const executed = await transferPost(
      'execute',
      {
        operationKey: request.sourceOperationKey,
        operation,
        reference: attempt.reference,
      },
      signal,
    );
    if (!current()) return uncertain();
    if (!executed.ok) return failure(executed, true);
    if (!parseTransferExecution(executed.body, request.previous.subjectAccountId)) return uncertain();
    // Acknowledgement is already evidence even when persistence fails. It cannot authorize another read.
    if (!persist({ ...attempt, phase: 'readback' }))
      return { kind: 'acknowledged', reference: attempt.reference!, readback: unavailable() };
  }
  if (!current()) return { kind: 'acknowledged', reference: attempt.reference!, readback: unavailable() };
  const relation = await readOperatorRelation(request.previous.subjectAccountId, attempt.accountId, signal);
  if (!current()) return { kind: 'acknowledged', reference: attempt.reference!, readback: unavailable() };
  if (relation.kind !== 'ready') return { kind: 'acknowledged', reference: attempt.reference!, readback: relation };
  const observed = relation.relation;
  return {
    kind: 'acknowledged',
    reference: attempt.reference!,
    readback:
      observed.previous.operatorAccountId === request.operatorAccountId &&
      BigInt(observed.expectedVersion) > BigInt(request.expectedVersion) &&
      observed.previous.reservationId !== request.previous.reservationId
        ? { kind: 'current', relation: observed }
        : { kind: 'failure', reason: 'conflict' },
  };
}

/** Reauthentication stays on the transfer page; there is no return URL. The
 * descriptor/key/ref stay saved and a second, explicit confirmation is required. */
export async function reauthenticateTransfer(
  accountId: string,
  email: string,
  password: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<TransferFailure | null> {
  const current = await loadAccountSession(signal);
  if (current.kind !== 'ready' || current.accountId !== accountId)
    return { kind: 'failure', reason: 'account-changed' };
  if (!isCurrent()) return { kind: 'failure', reason: 'unavailable' };
  const result = await submitSignIn(
    '/signin',
    { email, password, ...OPERATOR_MANAGEMENT_PROFILE },
    OPERATOR_MANAGEMENT_PROFILE,
  );
  if (!isCurrent()) return { kind: 'failure', reason: 'unavailable' };
  if (!result.ok) return failure(result);
  return boundSession(accountId, signal);
}
