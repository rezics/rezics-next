import { managementOperationProfile, type AccountOperation, type ManagementSession } from '@rezics/auth-contract';
import { authPost, type AuthPostResult } from './api';
import { loadManagementSession } from './management-operations';
import { normalizeSignupHandle } from './signup';

// The installed shared discriminator has no automated alias. Reuse its actual
// account:manage profile without changing registration ceilings or step-up kinds.
export const AUTOMATED_PROFILE = managementOperationProfile('transfer');
export type AutomatedOperation = Readonly<
  Omit<Extract<AccountOperation, { kind: 'automated' }>, 'authorization'> & {
    registrationId: '';
    operationKey: string;
    handle: string;
  }
>;
export type AutomatedAttempt = Readonly<{
  accountId: string;
  operationKey: string;
  operation: AutomatedOperation;
  operator: OperatorIdentity;
  reference?: string;
  submitted?: true;
}>;
export type OperatorIdentity = Readonly<{
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
}>;
export type AutomatedOutcome =
  | { kind: 'complete'; accountId: string }
  | { kind: 'step-up' | 'refused' | 'unknown' | 'unavailable' };
export type OperatorRead = { kind: 'ready'; operator: OperatorIdentity } | { kind: 'unavailable' };
const storageKey = 'rezics.automated-create.attempt';
export function automatedId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function identity(value: unknown): value is OperatorIdentity {
  return (
    record(value) &&
    fields(value, ['id', 'kind', 'handle', 'displayName']) &&
    automatedId(value.id) &&
    (value.kind === 'actor' || value.kind === 'organization') &&
    (value.handle === null || typeof value.handle === 'string') &&
    (value.displayName === null || typeof value.displayName === 'string')
  );
}

/** Compatibility parser for the existing generic management projection only.
 * The automated creation loader consumes parseAutomatedCreationOperator below. */
export function parseAutomatedOperator(body: unknown, operatorAccountId: string): OperatorRead {
  if (
    !record(body) ||
    !fields(body, ['account', 'self', 'role', 'operator', 'relation', 'members', 'responsibilities']) ||
    !identity(body.account) ||
    body.account.id !== operatorAccountId ||
    typeof body.self !== 'boolean' ||
    ![null, 'owner', 'member'].includes(body.role as never) ||
    body.operator !== null ||
    body.relation !== null
  )
    return { kind: 'unavailable' };
  return { kind: 'ready', operator: Object.freeze({ ...body.account }) };
}

/** Closed response from the selected native command metadata transport. */
export function parseAutomatedCreationOperator(body: unknown, operatorAccountId: string): OperatorRead {
  return identity(body) && body.id === operatorAccountId
    ? { kind: 'ready', operator: Object.freeze({ ...body }) }
    : { kind: 'unavailable' };
}

async function readOperator(accountId: string, operatorAccountId: string): Promise<OperatorRead> {
  const session = await loadManagementSession();
  if (session.kind !== 'ready' || !automatedSessionMatches(session, accountId)) return { kind: 'unavailable' };
  const result = await authPost('/account-management/automated/operator', { operatorAccountId });
  if (!result.ok) return { kind: 'unavailable' };
  // Session substitution while the selected label was loading cannot change the
  // immutable initiating human. Auth independently verifies the genuine session.
  const current = await loadManagementSession();
  if (
    current.kind !== 'ready' ||
    !automatedSessionMatches(current, accountId) ||
    current.authnEpoch !== session.authnEpoch ||
    current.authTime !== session.authTime ||
    JSON.stringify(current.amr) !== JSON.stringify(session.amr)
  )
    return { kind: 'unavailable' };
  return parseAutomatedCreationOperator(result.body, operatorAccountId);
}
export async function loadAutomatedOperator(accountId: string, operatorAccountId: string): Promise<OperatorRead> {
  if (!automatedId(accountId) || !automatedId(operatorAccountId)) return { kind: 'unavailable' };
  try {
    return await readOperator(accountId, operatorAccountId);
  } catch {
    return { kind: 'unavailable' };
  }
}

export function parseAutomatedAttempt(value: unknown): AutomatedAttempt | null {
  if (
    !record(value) ||
    !fields(value, [
      'accountId',
      'operationKey',
      'operation',
      'operator',
      ...(Object.hasOwn(value, 'reference') ? ['reference'] : []),
      ...(Object.hasOwn(value, 'submitted') ? ['submitted'] : []),
    ]) ||
    !automatedId(value.accountId) ||
    !text(value.operationKey) ||
    value.operationKey.length > 128 ||
    !identity(value.operator) ||
    (value.reference !== undefined && !text(value.reference)) ||
    (value.submitted !== undefined && value.submitted !== true)
  )
    return null;
  const op = value.operation;
  if (
    !record(op) ||
    !fields(op, ['kind', 'registrationId', 'operationKey', 'operatorAccountId', 'handle']) ||
    op.kind !== 'automated' ||
    op.registrationId !== '' ||
    op.operationKey !== value.operationKey ||
    op.operatorAccountId !== value.operator.id ||
    typeof op.handle !== 'string' ||
    normalizeSignupHandle(op.handle) !== op.handle
  )
    return null;
  return Object.freeze({
    accountId: value.accountId,
    operationKey: value.operationKey,
    operation: Object.freeze({
      kind: 'automated',
      registrationId: '',
      operationKey: value.operationKey,
      operatorAccountId: value.operator.id,
      handle: op.handle,
    }),
    operator: Object.freeze({ ...value.operator }),
    ...(value.reference === undefined ? {} : { reference: value.reference as string }),
    ...(value.submitted === true ? { submitted: true as const } : {}),
  });
}
export function createAutomatedAttempt(
  accountId: string,
  operator: OperatorIdentity,
  handle: string,
): AutomatedAttempt | null {
  const operationKey = crypto.randomUUID();
  return parseAutomatedAttempt({
    accountId,
    operationKey,
    operator,
    operation: { kind: 'automated', registrationId: '', operationKey, operatorAccountId: operator.id, handle },
  });
}
export function saveAutomatedAttempt(attempt: AutomatedAttempt): boolean {
  const parsed = parseAutomatedAttempt(attempt);
  if (!parsed) return false;
  try {
    const previous = restoreAutomatedAttempt();
    if (
      previous === 'invalid' ||
      (previous &&
        (previous.accountId !== parsed.accountId ||
          previous.operationKey !== parsed.operationKey ||
          JSON.stringify(previous.operation) !== JSON.stringify(parsed.operation)))
    )
      return false;
    window.sessionStorage.setItem(storageKey, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}
export function restoreAutomatedAttempt(): AutomatedAttempt | null | 'invalid' {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    return parseAutomatedAttempt(JSON.parse(raw)) ?? 'invalid';
  } catch {
    return 'invalid';
  }
}
/** Discard only this page's unsent review; dispatched and older approved commands remain recoverable. */
export function discardAutomatedReview(attempt: AutomatedAttempt | null): void {
  const saved = restoreAutomatedAttempt();
  if (
    !attempt ||
    !saved ||
    saved === 'invalid' ||
    saved.operationKey !== attempt.operationKey ||
    saved.submitted ||
    saved.reference
  )
    return;
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Failure to remove a review must never overwrite a different command.
  }
}
export function automatedSessionMatches(session: ManagementSession, accountId: string): boolean {
  return (
    session.accountId === accountId &&
    session.clientId === AUTOMATED_PROFILE.client_id &&
    session.scopes.length === 1 &&
    session.scopes[0] === 'account:manage' &&
    Date.now() / 1000 - session.authTime <= 600
  );
}
async function boundSession(accountId: string): Promise<AutomatedOutcome | null> {
  const session = await loadManagementSession();
  if (session.kind === 'unavailable') return { kind: 'unavailable' };
  if (session.kind === 'signed-out') return { kind: 'step-up' };
  if (session.accountId !== accountId) return { kind: 'refused' };
  return automatedSessionMatches(session, accountId) ? null : { kind: 'step-up' };
}
function failure(result: Exclude<AuthPostResult, { ok: true }>): AutomatedOutcome {
  if (result.status === 401 && result.code === 'step_up_required') return { kind: 'step-up' };
  if ([400, 401, 403, 409, 413, 415].includes(result.status)) return { kind: 'refused' };
  return { kind: 'unknown' };
}

/** Only explicit confirmation calls this. Return/navigation never invokes it. */
export async function submitAutomatedAttempt(
  input: AutomatedAttempt,
  isCurrent: () => boolean = () => true,
): Promise<AutomatedOutcome> {
  let attempt = parseAutomatedAttempt({ ...input, submitted: true });
  if (!isCurrent() || !attempt || !saveAutomatedAttempt(attempt)) return { kind: 'refused' };
  const denied = await boundSession(attempt.accountId);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (denied) return denied;
  const { operation, operationKey, accountId } = attempt;
  {
    const approval = await authPost('/account-operations/approve', { operation, operationKey, accountId });
    if (!isCurrent()) return { kind: 'unavailable' };
    if (!approval.ok) return failure(approval);
    if (
      !record(approval.body) ||
      !fields(approval.body, ['reference', 'expiresAt']) ||
      !text(approval.body.reference) ||
      typeof approval.body.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(approval.body.expiresAt))
    )
      return { kind: 'unknown' };
    attempt = parseAutomatedAttempt({ ...attempt, reference: approval.body.reference })!;
    if (!saveAutomatedAttempt(attempt)) return { kind: 'unknown' };
  }
  const current = await boundSession(accountId);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (current) return current;
  const result = await authPost('/account-operations/execute', {
    operation,
    operationKey,
    accountId,
    reference: attempt.reference,
  });
  if (!result.ok) return failure(result);
  if (!record(result.body) || !fields(result.body, ['accountId']) || !automatedId(result.body.accountId))
    return { kind: 'unknown' };
  // Retain the immutable attempt even after success: navigation cannot accidentally
  // turn a lost acknowledgement into a new account/key. No automatic resubmit.
  return { kind: 'complete', accountId: result.body.accountId };
}

/** Native sign-in materializes only existing current consent. No creation effect. */
export async function reauthenticateAutomated(
  accountId: string,
  email: string,
  password: string,
  isCurrent: () => boolean = () => true,
): Promise<AutomatedOutcome | null> {
  const before = await loadManagementSession();
  if (!isCurrent()) return { kind: 'unavailable' };
  if (before.kind !== 'ready' || before.accountId !== accountId) return { kind: 'refused' };
  const result = await authPost('/signin', { email, password, ...AUTOMATED_PROFILE });
  if (!isCurrent()) return { kind: 'unavailable' };
  if (!result.ok) return { kind: 'unavailable' };
  return boundSession(accountId);
}
