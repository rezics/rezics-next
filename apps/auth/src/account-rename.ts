import {
  managementOperationProfile,
  RENAME_PAGE_MAX_RESPONSE_BYTES,
  RENAME_PAGE_MAX_ACTIONS,
  RENAME_PAGE_MAX_ID_LENGTH,
} from '@rezics/auth-contract';
import { sendRenameApproval, sendRenameExecution } from './rename-command';
import { readJsonBounded } from './private-auth-json';
import { privateAuthRead } from './private-auth-read';
import { loadAccountSession } from './account-operations';
import { createSignupKey, normalizeSignupHandle } from './signup';
import {
  clearPendingManagementOperationStepUp,
  consumeRenameReviewReturn,
  managementOperationStepUpUrl,
  pendingManagementOperationMatches,
  pendingManagementOperationStepUpState,
  pendingRenameReviewStepUpState,
  storePendingManagementOperationStepUp,
  storePendingRenameReviewStepUp,
} from './management-operation-step-up';

export const RENAME_ROUTE = '/account/rename';
export const RENAME_PROFILE = managementOperationProfile('rename');

export type RenameOperation = Readonly<{
  kind: 'rename';
  accountId: string;
  handle: string;
  expectedHandle: string | null;
}>;
export type RenameTarget = {
  accountId: string;
  handle: string | null;
  clientId?: string;
  scopes?: readonly string[];
  authnEpoch?: number;
  authTime?: number;
  amr?: readonly string[];
  managementReviewReturned?: boolean;
};
export type RenameRead =
  | { kind: 'ready'; target: RenameTarget }
  | { kind: 'refused'; target?: RenameTarget }
  | { kind: 'management-auth-required'; accountId: string }
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; target?: RenameTarget };
/** The page owner supplies only the authenticated bounded projection, never a handle lookup. */
export type RenamePageReader = (accountId: string, signal?: AbortSignal) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function currentHandle(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.exec(value)?.[0] === value);
}
export function parseRenameProfile(body: unknown, accountId: string): { handle: string | null } | null {
  if (!record(body) || !record(body.profile)) return null;
  const profile = body.profile;
  if (profile.id !== accountId || profile.kind !== 'actor' || !currentHandle(profile.handle)) return null;
  return { handle: profile.handle };
}

async function readNativeRenamePage(_accountId: string, signal?: AbortSignal): Promise<unknown> {
  return privateAuthRead(async (readSignal) => {
    const response = await fetch('/account-management/rename-page', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: readSignal,
    });
    if (response.status !== 200) throw new Error('Account profile unavailable');
    return readJsonBounded(response, RENAME_PAGE_MAX_RESPONSE_BYTES, readSignal);
  }, signal);
}

export function parseRenamePage(body: unknown, accountId: string): RenameRead {
  if (!record(body)) return { kind: 'unavailable' };
  if (body.state === 'signed-out' && Object.keys(body).join(',') === 'state') return { kind: 'signed-out' };
  if (
    body.state === 'management-auth-required' &&
    Object.keys(body).sort().join(',') === 'continuation,state' &&
    record(body.continuation) &&
    Object.keys(body.continuation).sort().join(',') === 'kind,operation' &&
    body.continuation.kind === 'management-operation-step-up' &&
    body.continuation.operation === 'rename'
  )
    return { kind: 'management-auth-required', accountId };
  if (body.state === 'refused' && Object.keys(body).join(',') === 'state') return { kind: 'refused' };
  if (body.state === 'unavailable' && Object.keys(body).join(',') === 'state') return { kind: 'unavailable' };
  if (
    body.state !== 'ready' ||
    Object.keys(body).sort().join(',') !== 'authActions,profile,state,viewer' ||
    !record(body.viewer) ||
    !record(body.authActions)
  )
    return { kind: 'unavailable' };
  const viewer = body.viewer;
  if (
    Object.keys(viewer).sort().join(',') !== 'accountId,amr,authTime,authnEpoch,clientId,kind,scopes' ||
    viewer.kind !== 'actor' ||
    typeof viewer.accountId !== 'string' ||
    !viewer.accountId ||
    viewer.accountId.length > RENAME_PAGE_MAX_ID_LENGTH ||
    viewer.clientId !== RENAME_PROFILE.client_id ||
    !Array.isArray(viewer.scopes) ||
    viewer.scopes.length !== 1 ||
    viewer.scopes[0] !== RENAME_PROFILE.scope[0] ||
    !Number.isSafeInteger(viewer.authnEpoch) ||
    (viewer.authnEpoch as number) < 1 ||
    !Number.isSafeInteger(viewer.authTime) ||
    (viewer.authTime as number) < 0 ||
    !Array.isArray(viewer.amr) ||
    viewer.amr.length !== 1 ||
    (viewer.amr[0] !== 'pwd' && viewer.amr[0] !== 'pop')
  )
    return { kind: 'unavailable' };
  if (viewer.accountId !== accountId) return { kind: 'refused' };
  if (!record(body.profile) || Object.keys(body.profile).sort().join(',') !== 'handle,id,kind')
    return { kind: 'unavailable' };
  const profile = parseRenameProfile({ profile: body.profile }, accountId);
  if (!profile) return { kind: 'unavailable' };
  const target: RenameTarget = {
    accountId,
    handle: profile.handle,
    clientId: viewer.clientId,
    scopes: viewer.scopes as string[],
    authnEpoch: viewer.authnEpoch as number,
    authTime: viewer.authTime as number,
    amr: viewer.amr as string[],
  };
  const actions = body.authActions;
  if (actions.state === 'unavailable' && Object.keys(actions).sort().join(',') === 'state')
    return { kind: 'unavailable', target };
  if (
    actions.state !== 'ready' ||
    Object.keys(actions).sort().join(',') !== 'operations,state' ||
    !Array.isArray(actions.operations)
  )
    return { kind: 'unavailable' };
  if (actions.operations.length > RENAME_PAGE_MAX_ACTIONS) return { kind: 'unavailable' };
  let canRename = false;
  for (const operation of actions.operations) {
    if (
      !record(operation) ||
      Object.keys(operation).sort().join(',') !== 'action,operationId,resource' ||
      operation.operationId !== 'auth.account.rename' ||
      operation.action !== 'account:update' ||
      !record(operation.resource) ||
      Object.keys(operation.resource).sort().join(',') !== 'id,route' ||
      operation.resource.id !== accountId ||
      accountId.length !== 36 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operation.resource.id as string) ||
      !Number.isSafeInteger(operation.resource.route)
    )
      return { kind: 'unavailable' };
    canRename = true;
  }
  if (!canRename) return { kind: 'refused', target };
  const reviewReturn = pendingRenameReviewStepUpState();
  target.managementReviewReturned =
    renameContinuationPermits(null) &&
    reviewReturn.kind === 'pending' &&
    reviewReturn.value.accountId === accountId &&
    reviewReturn.value.phase === 'returned' &&
    consumeRenameReviewReturn(accountId);
  return { kind: 'ready', target };
}

export async function loadRenameTarget(
  readPage: RenamePageReader = readNativeRenamePage,
  signal?: AbortSignal,
): Promise<RenameRead> {
  const session = await loadAccountSession(signal);
  if (session.kind === 'signed-out') return { kind: 'signed-out' };
  if (session.kind !== 'ready') return { kind: 'unavailable' };
  try {
    if (signal?.aborted) return { kind: 'unavailable' };
    const body = await readPage(session.accountId, signal);
    return signal?.aborted ? { kind: 'unavailable' } : parseRenamePage(body, session.accountId);
  } catch {
    return { kind: 'unavailable' };
  }
}

export function renameSessionMatches(target: RenameTarget): boolean {
  return (
    target.clientId === RENAME_PROFILE.client_id && target.scopes?.length === 1 && target.scopes[0] === 'account:update'
  );
}
export type RenameContinuation = {
  readonly accountId: string;
  readonly operationKey: string;
  readonly operation: RenameOperation;
  submitted: boolean;
};
export type RenameAttempt = RenameContinuation & {
  reference?: string;
  referenceExpiresAt?: string;
  /** Live acknowledgement survives a failed or retired current observation. */
  acknowledged?: boolean;
};
const storageKey = 'rezics.account-rename.pending';
// Compatible with native descriptor/continuation callers (the native page uses 1024).
export const RENAME_CONTINUATION_MAX_ID_CODE_UNITS = 4096;
const continuationSkeleton = {
  accountId: '',
  operationKey: '',
  operation: { kind: 'rename', accountId: '', handle: '', expectedHandle: '' },
  submitted: false,
};
/** String.length units: closed JSON punctuation + two escaped IDs + hex32 + two ASCII handle64s. */
export const RENAME_CONTINUATION_MAX_CODE_UNITS =
  JSON.stringify(continuationSkeleton).length + 2 * 6 * RENAME_CONTINUATION_MAX_ID_CODE_UNITS + 32 + 2 * 64;
export type RenameContinuationState =
  | { kind: 'absent' }
  | { kind: 'valid'; value: RenameContinuation }
  | { kind: 'refused' };

export function parseRenameContinuation(value: unknown): RenameContinuation | null {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'accountId,operation,operationKey,submitted')
    return null;
  const op = value.operation;
  if (!record(op) || Object.keys(op).sort().join(',') !== 'accountId,expectedHandle,handle,kind') return null;
  if (
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    value.accountId.length > RENAME_CONTINUATION_MAX_ID_CODE_UNITS ||
    op.accountId !== value.accountId ||
    typeof value.operationKey !== 'string' ||
    value.operationKey.length !== 32 ||
    !/^[a-f0-9]{32}$/.test(value.operationKey) ||
    typeof value.submitted !== 'boolean' ||
    op.kind !== 'rename' ||
    typeof op.handle !== 'string' ||
    normalizeSignupHandle(op.handle) !== op.handle ||
    !currentHandle(op.expectedHandle) ||
    op.handle === op.expectedHandle
  )
    return null;
  return {
    accountId: value.accountId,
    operationKey: value.operationKey,
    submitted: value.submitted,
    operation: Object.freeze({
      kind: 'rename',
      accountId: value.accountId,
      handle: op.handle,
      expectedHandle: op.expectedHandle,
    }),
  };
}
export function createRenameAttempt(target: RenameTarget, input: string): RenameAttempt | null {
  const handle = normalizeSignupHandle(input);
  if (
    !target.accountId ||
    target.accountId.length > RENAME_CONTINUATION_MAX_ID_CODE_UNITS ||
    !currentHandle(target.handle) ||
    !handle ||
    handle === target.handle
  )
    return null;
  return {
    accountId: target.accountId,
    operationKey: createSignupKey(),
    submitted: false,
    operation: Object.freeze({ kind: 'rename', accountId: target.accountId, handle, expectedHandle: target.handle }),
  };
}
export function saveRenameContinuation(attempt: RenameContinuation): boolean {
  // Credentials and approval references stay out of storage and URLs.
  const closed = parseRenameContinuation({
    accountId: attempt.accountId,
    operationKey: attempt.operationKey,
    operation: {
      kind: attempt.operation.kind,
      accountId: attempt.operation.accountId,
      handle: attempt.operation.handle,
      expectedHandle: attempt.operation.expectedHandle,
    },
    submitted: attempt.submitted,
  });
  if (!closed) return false;
  const retained = readRenameContinuationState();
  if (
    retained.kind === 'refused' ||
    (retained.kind === 'valid' &&
      (!sameRenameContinuation(retained.value, closed) || (retained.value.submitted && !closed.submitted)))
  )
    return false;
  const raw = JSON.stringify(closed);
  if (raw.length > RENAME_CONTINUATION_MAX_CODE_UNITS) return false;
  try {
    window.sessionStorage.setItem(storageKey, raw);
    return true;
  } catch {
    // Dispatch can retain this exact attempt in memory; a handoff requires durability.
    return false;
  }
}
export function readRenameContinuationState(): RenameContinuationState {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return { kind: 'refused' };
  }
  if (raw === null) return { kind: 'absent' };
  if (raw.length > RENAME_CONTINUATION_MAX_CODE_UNITS) return { kind: 'refused' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'refused' };
    throw error;
  }
  const parsed = parseRenameContinuation(value);
  return parsed ? { kind: 'valid', value: parsed } : { kind: 'refused' };
}
/** Compatibility projection for observations in fixtures; production uses the explicit state. */
export function readRenameContinuation(): RenameContinuation | null {
  const state = readRenameContinuationState();
  return state.kind === 'valid' ? state.value : null;
}
/** An absent slot supports a live attempt after a failed write, never a refused slot. */
export function renameContinuationPermits(expected: RenameContinuation | null): boolean {
  const state = readRenameContinuationState();
  return (
    state.kind === 'absent' ||
    (state.kind === 'valid' && expected !== null && sameRenameContinuation(state.value, expected))
  );
}
export function sameRenameContinuation(left: RenameContinuation, right: RenameContinuation): boolean {
  return (
    left.accountId === right.accountId &&
    left.operationKey === right.operationKey &&
    left.operation.handle === right.operation.handle &&
    left.operation.expectedHandle === right.operation.expectedHandle
  );
}
export function clearRenameContinuation(expected?: RenameContinuation): void {
  // No caller can remove an unknown value or an unrelated command/marker.
  if (!expected) return;
  const state = readRenameContinuationState();
  if (
    state.kind !== 'valid' ||
    !sameRenameContinuation(state.value, expected) ||
    state.value.submitted !== expected.submitted
  )
    return;
  const pending = pendingManagementOperationStepUpState();
  if (pending.kind === 'pending' && pendingManagementOperationMatches(pending.value, expected))
    clearPendingManagementOperationStepUp();
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* The live attempt remains in memory. */
  }
}

export type RenameResult =
  | { kind: 'renamed'; target: RenameTarget }
  | { kind: 'acknowledged'; current: RenameRead }
  | { kind: 'conflict'; current: RenameRead }
  | { kind: 'step-up' | 'denied' | 'unavailable' | 'unknown'; current?: RenameRead };

/** Page-local adapter to the REAL native approval/execution transport. It never
 * supplies authorization, principal, assignment or a synthetic native proof. */
export async function runRenameAttempt(
  attempt: RenameAttempt,
  readCurrent: () => Promise<RenameRead>,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<RenameResult> {
  const closed = parseRenameContinuation({
    accountId: attempt.accountId,
    operationKey: attempt.operationKey,
    operation: attempt.operation,
    submitted: attempt.submitted,
  });
  if (!closed) return { kind: 'denied' };
  const owns = () => !signal?.aborted && isCurrent() && renameContinuationPermits(attempt);
  if (!owns()) return { kind: 'unavailable' };
  const current = await readCurrent();
  if (!owns()) return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
  if (current.kind !== 'ready') return { kind: attempt.submitted ? 'unknown' : 'unavailable', current };
  if (current.target.accountId !== closed.accountId) return { kind: 'denied', current };
  if (!renameSessionMatches(current.target)) return { kind: 'step-up' };
  if (
    current.target.handle !== closed.operation.expectedHandle &&
    !(attempt.submitted && current.target.handle === closed.operation.handle)
  ) {
    return { kind: 'conflict', current };
  }
  const body = { operationKey: closed.operationKey, operation: closed.operation };
  if (attempt.referenceExpiresAt && Date.parse(attempt.referenceExpiresAt) <= Date.now()) {
    delete attempt.reference;
    delete attempt.referenceExpiresAt;
  }
  if (!attempt.reference) {
    const approval = await sendRenameApproval(body, owns, signal);
    if (!owns()) return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
    if (approval.kind === 'unavailable') return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
    if (approval.kind === 'refused') {
      if (approval.value.error === 'step_up_required') return { kind: 'step-up' };
      if (approval.status === 409) return { kind: 'conflict', current: await readCurrent() };
      return { kind: approval.status === 401 || approval.status === 403 ? 'denied' : 'unavailable' };
    }
    if (Date.parse(approval.value.expiresAt) <= Date.now())
      return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
    attempt.reference = approval.value.reference;
    attempt.referenceExpiresAt = approval.value.expiresAt;
  }
  const previouslySubmitted = attempt.submitted;
  let dispatched = false;
  const executed = await sendRenameExecution(
    { ...body, reference: attempt.reference },
    () => {
      if (!owns()) return false;
      attempt.submitted = true;
      saveRenameContinuation(attempt);
      // A quota error preserves the live send; a refused/replaced slot never does.
      if (!owns()) {
        attempt.submitted = previouslySubmitted;
        return false;
      }
      dispatched = true;
      return true;
    },
    signal,
  );
  if (!owns()) return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
  if (executed.kind === 'unavailable') return { kind: dispatched || previouslySubmitted ? 'unknown' : 'unavailable' };
  if (executed.kind === 'refused') {
    if ([401, 403, 409].includes(executed.status)) {
      if (!previouslySubmitted) clearRenameContinuation(attempt);
      attempt.submitted = previouslySubmitted;
    }
    if (executed.status === 409) return { kind: 'conflict', current: await readCurrent() };
    if (executed.value.error === 'step_up_required') {
      delete attempt.reference;
      delete attempt.referenceExpiresAt;
      return { kind: 'step-up' };
    }
    if (executed.status === 401 || executed.status === 403) return { kind: 'denied' };
    return { kind: 'unknown' };
  }
  if (executed.value.accountId !== closed.accountId) return { kind: 'unknown' };
  attempt.acknowledged = true;
  // Settle only the admitted original descriptor, including a failed marker write.
  const stored = readRenameContinuationState();
  if (stored.kind === 'valid' && sameRenameContinuation(stored.value, attempt)) clearRenameContinuation(stored.value);
  // A workflow receipt alone never establishes the currently effective handle.
  let observed: RenameRead;
  try {
    observed = await readCurrent();
  } catch {
    observed = { kind: 'unavailable' };
  }
  if (!owns()) return { kind: 'acknowledged', current: { kind: 'unavailable' } };
  return observed.kind === 'ready' &&
    observed.target.accountId === closed.accountId &&
    renameSessionMatches(observed.target) &&
    observed.target.handle === closed.operation.handle
    ? { kind: 'renamed', target: observed.target }
    : { kind: 'acknowledged', current: observed };
}

export interface RenameSource {
  readCurrent(signal?: AbortSignal): Promise<RenameRead>;
  run(attempt: RenameAttempt, isCurrent?: () => boolean, signal?: AbortSignal): Promise<RenameResult>;
  /** Owner composition saves/validates the same continuation, signs in for the
   * management profile, then returns here WITHOUT executing. Check isCurrent
   * after any await before storing a continuation or navigating the browser. */
  stepUp(attempt: RenameContinuation, isCurrent?: () => boolean): Promise<boolean>;
  stepUpForReview?(accountId: string, isCurrent?: () => boolean): Promise<boolean>;
}
export const nativeRenameSource: RenameSource = {
  readCurrent: (signal) => loadRenameTarget(undefined, signal),
  run: (attempt, isCurrent, signal) =>
    runRenameAttempt(attempt, () => nativeRenameSource.readCurrent(signal), isCurrent, signal),
  stepUp: async (attempt, isCurrent = () => true) => {
    if (!renameContinuationPermits(attempt)) return false;
    const input = { accountId: attempt.accountId, operationKey: attempt.operationKey, operation: attempt.operation };
    if (!isCurrent() || !saveRenameContinuation(attempt) || !storePendingManagementOperationStepUp(input)) return false;
    window.location.assign(managementOperationStepUpUrl('rename'));
    return true;
  },
  stepUpForReview: async (accountId, isCurrent = () => true) => {
    if (!isCurrent() || !renameContinuationPermits(null) || !storePendingRenameReviewStepUp(accountId)) return false;
    window.location.assign(managementOperationStepUpUrl('rename'));
    return true;
  },
};
