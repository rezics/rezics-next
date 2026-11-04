import { managementOperationProfile } from '@rezics/auth-contract';
import { authPost } from './api';
import { loadAccountSession } from './account-operations';
import { createSignupKey, normalizeSignupHandle } from './signup';
import {
  clearPendingManagementOperationStepUp,
  clearPendingRenameReviewStepUp,
  consumeRenameReviewReturn,
  managementOperationStepUpUrl,
  pendingManagementOperationMatches,
  pendingManagementOperationStepUpState,
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
export type RenamePageReader = (accountId: string) => Promise<unknown>;

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

async function readNativeRenamePage(_accountId: string): Promise<unknown> {
  const result = await authPost('/account-management/rename-page', {});
  if (!result.ok) throw new Error('Account profile unavailable');
  return result.body;
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
    typeof viewer.clientId !== 'string' ||
    !Array.isArray(viewer.scopes) ||
    !viewer.scopes.every((scope) => typeof scope === 'string') ||
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
  if (actions.operations.length > 1) return { kind: 'unavailable' };
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
      !Number.isSafeInteger(operation.resource.route) ||
      (operation.resource.route as number) < 0 ||
      (operation.resource.route as number) > 65535
    )
      return { kind: 'unavailable' };
    canRename = true;
  }
  if (!canRename) {
    clearPendingRenameReviewStepUp();
    return { kind: 'refused', target };
  }
  target.managementReviewReturned = consumeRenameReviewReturn(accountId);
  return { kind: 'ready', target };
}

export async function loadRenameTarget(readPage: RenamePageReader = readNativeRenamePage): Promise<RenameRead> {
  const session = await loadAccountSession();
  if (session.kind === 'signed-out') return { kind: 'signed-out' };
  if (session.kind !== 'ready') return { kind: 'unavailable' };
  try {
    return parseRenamePage(await readPage(session.accountId), session.accountId);
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
export type RenameAttempt = RenameContinuation & { reference?: string };
const storageKey = 'rezics.account-rename.pending';

export function parseRenameContinuation(value: unknown): RenameContinuation | null {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'accountId,operation,operationKey,submitted')
    return null;
  const op = value.operation;
  if (!record(op) || Object.keys(op).sort().join(',') !== 'accountId,expectedHandle,handle,kind') return null;
  if (
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    op.accountId !== value.accountId ||
    typeof value.operationKey !== 'string' ||
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
  if (!target.accountId || !currentHandle(target.handle) || !handle || handle === target.handle) return null;
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
    operation: attempt.operation,
    submitted: attempt.submitted,
  });
  if (!closed) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(closed));
    return true;
  } catch {
    return false;
  }
}
export function readRenameContinuation(): RenameContinuation | null {
  try {
    return parseRenameContinuation(JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null'));
  } catch {
    return null;
  }
}
export function clearRenameContinuation(): void {
  const continuation = readRenameContinuation();
  const pending = pendingManagementOperationStepUpState();
  if (continuation && pending.kind === 'pending' && pendingManagementOperationMatches(pending.value, continuation))
    clearPendingManagementOperationStepUp();
  clearPendingRenameReviewStepUp();
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* The live attempt remains in memory. */
  }
}

export type RenameResult =
  | { kind: 'renamed'; target: RenameTarget }
  | { kind: 'conflict'; current: RenameRead }
  | { kind: 'step-up' | 'denied' | 'unavailable' | 'unknown' };

/** Page-local adapter to the REAL native approval/execution transport. It never
 * supplies authorization, principal, assignment or a synthetic native proof. */
export async function runRenameAttempt(
  attempt: RenameAttempt,
  readCurrent: () => Promise<RenameRead>,
  isCurrent: () => boolean = () => true,
): Promise<RenameResult> {
  const closed = parseRenameContinuation({
    accountId: attempt.accountId,
    operationKey: attempt.operationKey,
    operation: attempt.operation,
    submitted: attempt.submitted,
  });
  if (!closed) return { kind: 'denied' };
  if (!isCurrent() && !attempt.submitted) return { kind: 'unavailable' };
  const current = await readCurrent();
  if (!isCurrent() && !attempt.submitted) return { kind: 'unavailable' };
  if (current.kind !== 'ready') return { kind: attempt.submitted ? 'unknown' : 'unavailable' };
  if (current.target.accountId !== closed.accountId) return { kind: 'denied' };
  if (!renameSessionMatches(current.target)) return { kind: 'step-up' };
  if (current.target.handle !== closed.operation.expectedHandle) {
    if (attempt.submitted && current.target.handle === closed.operation.handle)
      return { kind: 'renamed', target: current.target };
    return { kind: 'conflict', current };
  }
  const body = { operationKey: closed.operationKey, operation: closed.operation };
  if (!attempt.reference) {
    const approval = await authPost<unknown>('/account-operations/approve', body);
    if (!approval.ok) {
      if (approval.code === 'step_up_required' && approval.status === 401) return { kind: 'step-up' };
      if (approval.status === 409) return { kind: 'conflict', current: await readCurrent() };
      return { kind: approval.status === 401 || approval.status === 403 ? 'denied' : 'unavailable' };
    }
    if (
      !record(approval.body) ||
      typeof approval.body.reference !== 'string' ||
      !approval.body.reference ||
      typeof approval.body.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(approval.body.expiresAt)) ||
      Date.parse(approval.body.expiresAt) <= Date.now()
    )
      return { kind: 'unavailable' };
    attempt.reference = approval.body.reference;
  }
  // An unsent review may end while approval is in flight. Already submitted
  // attempts still reconcile with their original key, descriptor and reference.
  if (!isCurrent() && !attempt.submitted) return { kind: 'unavailable' };
  attempt.submitted = true;
  if (isCurrent()) saveRenameContinuation(attempt);
  const executed = await authPost<unknown>('/account-operations/execute', { ...body, reference: attempt.reference });
  if (!executed.ok) {
    if (executed.status === 409) return { kind: 'conflict', current: await readCurrent() };
    if (executed.status === 401 && executed.code === 'step_up_required') {
      delete attempt.reference;
      return { kind: 'step-up' };
    }
    if (executed.status === 401 || executed.status === 403) return { kind: 'denied' };
    return { kind: 'unknown' };
  }
  if (
    !record(executed.body) ||
    executed.body.accountId !== closed.accountId ||
    executed.body.error ||
    executed.body.expired
  )
    return { kind: 'unknown' };
  // A workflow receipt alone never establishes the currently effective handle.
  const observed = await readCurrent();
  return observed.kind === 'ready' &&
    observed.target.accountId === closed.accountId &&
    renameSessionMatches(observed.target) &&
    observed.target.handle === closed.operation.handle
    ? { kind: 'renamed', target: observed.target }
    : { kind: 'unknown' };
}

export interface RenameSource {
  readCurrent(): Promise<RenameRead>;
  run(attempt: RenameAttempt, isCurrent?: () => boolean): Promise<RenameResult>;
  /** Owner composition saves/validates the same continuation, signs in for the
   * management profile, then returns here WITHOUT executing. Check isCurrent
   * after any await before storing a continuation or navigating the browser. */
  stepUp(attempt: RenameContinuation, isCurrent?: () => boolean): Promise<boolean>;
  stepUpForReview?(accountId: string, isCurrent?: () => boolean): Promise<boolean>;
}
export const nativeRenameSource: RenameSource = {
  readCurrent: () => loadRenameTarget(),
  run: (attempt, isCurrent) => runRenameAttempt(attempt, nativeRenameSource.readCurrent, isCurrent),
  stepUp: async (attempt, isCurrent = () => true) => {
    const input = { accountId: attempt.accountId, operationKey: attempt.operationKey, operation: attempt.operation };
    if (!isCurrent() || !saveRenameContinuation(attempt) || !storePendingManagementOperationStepUp(input)) return false;
    window.location.assign(managementOperationStepUpUrl('rename'));
    return true;
  },
  stepUpForReview: async (accountId, isCurrent = () => true) => {
    if (!isCurrent() || !storePendingRenameReviewStepUp(accountId)) return false;
    window.location.assign(managementOperationStepUpUrl('rename'));
    return true;
  },
};
