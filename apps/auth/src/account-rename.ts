import { authPost } from './api';
import { loadAccountSession } from './account-operations';
import { createSignupKey, normalizeSignupHandle } from './signup';

export const RENAME_ROUTE = '/account/rename';
// Local consumer contract until the management-operation owner exports it.
// The organization/delete client must retain its existing ceiling.
export const RENAME_PROFILE = { client_id: 'rezics-auth-account-management', scope: ['account:update'] } as const;
export const RENAME_MISSING_PORTS = {
  profile: 'Authenticated issuer adapter to GET /v1/accounts/{accountId}/profile using the current Auth session',
  stepUp: 'Management-client registration and shared /step-up rename continuation with exact account:update profile',
} as const;

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
};
export type RenameRead = { kind: 'ready'; target: RenameTarget } | { kind: 'signed-out' | 'unavailable' | 'denied' };
/** The owner supplies only the existing authenticated exact-ID projection, never a handle lookup. */
export type RenameProfileReader = (accountId: string) => Promise<unknown>;

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

export async function loadRenameTarget(readProfile?: RenameProfileReader): Promise<RenameRead> {
  const session = await loadAccountSession();
  if (session.kind === 'signed-out') return { kind: 'signed-out' };
  if (session.kind !== 'ready' || !readProfile) return { kind: 'unavailable' };
  try {
    const profile = parseRenameProfile(await readProfile(session.accountId), session.accountId);
    if (!profile) return { kind: 'unavailable' };
    return { kind: 'ready', target: { ...session, handle: profile.handle } };
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
}
export const nativeRenameSource: RenameSource = {
  readCurrent: () => loadRenameTarget(),
  run: (attempt, isCurrent) => runRenameAttempt(attempt, nativeRenameSource.readCurrent, isCurrent),
  stepUp: async (attempt, isCurrent = () => true) => {
    if (isCurrent()) saveRenameContinuation(attempt);
    return false;
  },
};
