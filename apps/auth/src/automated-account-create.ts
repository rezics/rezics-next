import {
  ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH,
  ACCOUNT_OPERATION_KEY_MAX_LENGTH,
  ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH,
  AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES,
  automatedAccountOperationResponseByteBudgets,
  managementOperationProfile,
  type AccountOperation,
  type AccountOperationApprovalResponse,
  type AutomatedAccountExecutionAcknowledgement,
  type ManagementSession,
} from '@rezics/auth-contract';
import { authPost } from './api';
import { signInResult } from './sign-in';
import { submitSignIn } from './sign-in-transport';
import { loadManagementSession } from './management-operations';
import { normalizeSignupHandle } from './signup';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

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
export type OperatorRead =
  | { kind: 'ready'; operator: OperatorIdentity }
  | { kind: 'step-up' | 'refused' | 'unavailable' };
export type AutomatedCreationPage = {
  viewer: { accountId: string };
  readiness: 'authentication-needed' | 'select-operator' | 'review' | 'refused';
  operator: OperatorIdentity | null;
  handleRules: { minLength: 3; maxLength: 64; normalization: 'lowercase'; pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]' };
  action: 'authenticate' | 'select-operator' | 'confirm' | 'none';
};
export type AutomatedPageRead =
  | { kind: 'ready'; page: AutomatedCreationPage }
  | { kind: 'refused' | 'signed-out' | 'unavailable' };
const storageKey = 'rezics.automated-create.attempt';
const AUTOMATED_ATTEMPT_MAX_REFERENCE_LENGTH = 4096;
function attemptStorageSkeleton(reference: boolean, submitted: boolean) {
  return JSON.stringify({
    accountId: '',
    operationKey: '',
    operation: {
      kind: 'automated',
      registrationId: '',
      operationKey: '',
      operatorAccountId: '',
      handle: '',
    },
    operator: { id: '', kind: 'organization', handle: '', displayName: '' },
    ...(reference ? { reference: '' } : {}),
    ...(submitted ? { submitted: true } : {}),
  }).length;
}
function attemptStorageStringUnits(reference: boolean) {
  return (
    AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH +
    2 * AUTOMATED_CREATION_PAGE_MAX_ID_LENGTH +
    2 * AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH +
    6 *
      (2 * ACCOUNT_OPERATION_KEY_MAX_LENGTH +
        AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH +
        (reference ? AUTOMATED_ATTEMPT_MAX_REFERENCE_LENGTH : 0))
  );
}
const automatedAttemptStorageVariants = [false, true].flatMap((reference) =>
  [false, true].map((submitted) => attemptStorageSkeleton(reference, submitted) + attemptStorageStringUnits(reference)),
);
/** Maximum canonical JSON string length in UTF-16 code units, including all
 * reference/submitted marker combinations. UUIDs/handles are fixed ASCII;
 * operation keys, display names and approval references use six-unit escaping. */
export const AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16 = Math.max(...automatedAttemptStorageVariants);
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
    (value.handle === null ||
      (typeof value.handle === 'string' &&
        value.handle.length <= AUTOMATED_CREATION_PAGE_MAX_HANDLE_LENGTH &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.exec(value.handle)?.[0] === value.handle)) &&
    (value.displayName === null ||
      (typeof value.displayName === 'string' &&
        value.displayName.length <= AUTOMATED_CREATION_PAGE_MAX_DISPLAY_NAME_LENGTH))
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

/** Close the native page, including advice; a matching browser profile is no grant. */
export function parseAutomatedCreationPage(
  body: unknown,
  accountId: string,
  operatorAccountId: string | null,
): AutomatedPageRead {
  if (
    !record(body) ||
    !fields(body, ['viewer', 'readiness', 'operator', 'handleRules', 'action']) ||
    !record(body.viewer) ||
    !fields(body.viewer, ['accountId']) ||
    body.viewer.accountId !== accountId ||
    !record(body.handleRules) ||
    !fields(body.handleRules, ['minLength', 'maxLength', 'normalization', 'pattern']) ||
    body.handleRules.minLength !== 3 ||
    body.handleRules.maxLength !== 64 ||
    body.handleRules.normalization !== 'lowercase' ||
    body.handleRules.pattern !== '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]'
  )
    return { kind: 'unavailable' };
  const actions = {
    'authentication-needed': 'authenticate',
    'select-operator': 'select-operator',
    review: 'confirm',
    refused: 'none',
  };
  if (
    typeof body.readiness !== 'string' ||
    !Object.hasOwn(actions, body.readiness) ||
    body.action !== actions[body.readiness as keyof typeof actions] ||
    (body.readiness === 'review'
      ? !identity(body.operator) || body.operator.id !== operatorAccountId
      : body.operator !== null) ||
    (body.readiness === 'select-operator' && operatorAccountId !== null) ||
    (body.readiness === 'refused' && operatorAccountId === null)
  )
    return { kind: 'unavailable' };
  return { kind: 'ready', page: body as AutomatedCreationPage };
}
export function parseAutomatedCreationOperator(
  body: unknown,
  operatorAccountId: string,
  accountId: string,
): OperatorRead {
  const read = parseAutomatedCreationPage(body, accountId, operatorAccountId);
  if (read.kind !== 'ready') return { kind: 'unavailable' };
  if (read.page.readiness === 'review' && read.page.operator) return { kind: 'ready', operator: read.page.operator };
  return { kind: read.page.readiness === 'authentication-needed' ? 'step-up' : 'refused' };
}

export async function loadAutomatedCreationPage(
  accountId: string,
  operatorAccountId: string | null,
  caller?: AbortSignal,
): Promise<AutomatedPageRead> {
  if (!automatedId(accountId) || (operatorAccountId !== null && !automatedId(operatorAccountId)))
    return { kind: 'unavailable' };
  try {
    return await privateAuthRead(async (signal) => {
      const session = await loadManagementSession(signal);
      if (session.kind !== 'ready') return session;
      if (session.accountId !== accountId) return { kind: 'refused' };
      const response = await fetch('/account-management/automated/operator', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorAccountId }),
        signal,
      });
      const body: unknown = await readJsonBounded(response, AUTOMATED_CREATION_PAGE_MAX_RESPONSE_BYTES, signal);
      if (response.status !== 200)
        return { kind: response.status === 401 ? 'signed-out' : response.status === 403 ? 'refused' : 'unavailable' };
      const current = await loadManagementSession(signal);
      if (
        current.kind !== 'ready' ||
        current.accountId !== accountId ||
        current.clientId !== session.clientId ||
        JSON.stringify(current.scopes) !== JSON.stringify(session.scopes) ||
        current.authnEpoch !== session.authnEpoch ||
        current.authTime !== session.authTime ||
        JSON.stringify(current.amr) !== JSON.stringify(session.amr)
      )
        return { kind: 'unavailable' };
      return parseAutomatedCreationPage(body, accountId, operatorAccountId);
    }, caller);
  } catch {
    return { kind: 'unavailable' };
  }
}
export async function loadAutomatedOperator(accountId: string, operatorAccountId: string): Promise<OperatorRead> {
  const read = await loadAutomatedCreationPage(accountId, operatorAccountId);
  if (read.kind !== 'ready') return { kind: read.kind === 'signed-out' ? 'step-up' : read.kind };
  if (read.page.readiness === 'review' && read.page.operator) return { kind: 'ready', operator: read.page.operator };
  return { kind: read.page.readiness === 'authentication-needed' ? 'step-up' : 'refused' };
}

export function parseAutomatedAttempt(value: unknown): AutomatedAttempt | null {
  const hasReference = record(value) && Object.hasOwn(value, 'reference');
  const hasSubmitted = record(value) && Object.hasOwn(value, 'submitted');
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
    value.operationKey.length > ACCOUNT_OPERATION_KEY_MAX_LENGTH ||
    !identity(value.operator) ||
    (hasReference && (!text(value.reference) || value.reference.length > AUTOMATED_ATTEMPT_MAX_REFERENCE_LENGTH)) ||
    (hasSubmitted && value.submitted !== true)
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
  // An unknown or unreadable retained command is never treated as absence.
  if (restoreAutomatedAttempt() !== null) return null;
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
          JSON.stringify(previous.operation) !== JSON.stringify(parsed.operation) ||
          JSON.stringify(previous.operator) !== JSON.stringify(parsed.operator)))
    )
      return false;
    const retained = parseAutomatedAttempt({
      ...parsed,
      ...(previous?.submitted ? { submitted: true as const } : {}),
      ...(previous?.reference && !parsed.reference ? { reference: previous.reference } : {}),
    });
    if (!retained) return false;
    const serialized = JSON.stringify(retained);
    if (serialized.length > AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16) return false;
    window.sessionStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
export function restoreAutomatedAttempt(): AutomatedAttempt | null | 'invalid' {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    if (raw.length > AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16) return 'invalid';
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
    saved.accountId !== attempt.accountId ||
    saved.operationKey !== attempt.operationKey ||
    JSON.stringify(saved.operation) !== JSON.stringify(attempt.operation) ||
    JSON.stringify(saved.operator) !== JSON.stringify(attempt.operator) ||
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
async function boundSession(accountId: string, signal?: AbortSignal): Promise<AutomatedOutcome | null> {
  const session = await loadManagementSession(signal);
  if (session.kind === 'unavailable') return { kind: 'unavailable' };
  if (session.kind === 'signed-out') return { kind: 'step-up' };
  if (session.accountId !== accountId) return { kind: 'refused' };
  return automatedSessionMatches(session, accountId) ? null : { kind: 'step-up' };
}

type BoundedCommandResponse = { kind: 'response'; status: number; body: unknown } | { kind: 'unavailable' };

/** Each command owns its existing five-second lifetime through streamed body consumption. */
async function boundedCommandPost(
  path: string,
  body: unknown,
  maxBytes: number,
  caller?: AbortSignal,
): Promise<BoundedCommandResponse> {
  const serialized = JSON.stringify(body);
  try {
    return await privateAuthRead(async (signal) => {
      let response: Response;
      try {
        response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: serialized,
          signal,
        });
      } catch (error) {
        if (signal.aborted || error instanceof TypeError) return { kind: 'unavailable' };
        throw error;
      }
      let responseBody: unknown;
      try {
        responseBody = await readJsonBounded(response, maxBytes, signal);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.message === 'Private JSON response unavailable'))
          return { kind: 'unavailable' };
        throw error;
      }
      return {
        kind: 'response' as const,
        status: response.status,
        body: responseBody,
      };
    }, caller);
  } catch (error) {
    if (caller?.aborted || (error instanceof DOMException && error.name === 'TimeoutError'))
      return { kind: 'unavailable' };
    throw error;
  }
}

function approvalResponse(body: unknown): AccountOperationApprovalResponse | null {
  if (
    !record(body) ||
    !fields(body, ['reference', 'expiresAt']) ||
    typeof body.reference !== 'string' ||
    body.reference.length === 0 ||
    body.reference.length > ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH ||
    typeof body.expiresAt !== 'string' ||
    body.expiresAt.length !== ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH
  )
    return null;
  const expires = Date.parse(body.expiresAt);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== body.expiresAt || expires <= Date.now())
    return null;
  return { reference: body.reference, expiresAt: body.expiresAt };
}

function executionAcknowledgement(body: unknown): AutomatedAccountExecutionAcknowledgement | null {
  if (!record(body) || !fields(body, ['accountId']) || !automatedId(body.accountId)) return null;
  return { accountId: body.accountId };
}

/** Classify only the closed Auth-host status/body pairs for these commands. */
function commandFailure(command: 'approve' | 'execute', status: number, body: unknown): AutomatedOutcome | null {
  if (!record(body)) return null;
  if (
    command === 'approve' &&
    status === 403 &&
    fields(body, ['error', 'effect_status']) &&
    body.error === 'platform_closed' &&
    body.effect_status === 'not_applied'
  )
    return { kind: 'refused' };
  if (
    status === 401 &&
    fields(body, ['error', 'effect_status']) &&
    body.error === 'step_up_required' &&
    body.effect_status === 'not_applied'
  )
    return { kind: 'step-up' };
  if (
    fields(body, ['error', 'effect_status']) &&
    body.error === 'account_operation_denied' &&
    body.effect_status === 'not_applied' &&
    [400, 401, 403, 409, 413, 415].includes(status)
  )
    return { kind: 'refused' };
  if (
    status === 503 &&
    fields(body, ['error', 'effect_status']) &&
    body.error === 'account_operation_denied' &&
    body.effect_status === 'not_applied'
  )
    return { kind: 'unknown' };
  if (status === 503 && fields(body, ['error']) && body.error === 'account_operation_unresolved')
    return { kind: 'unknown' };
  return null;
}

/** Only explicit confirmation calls this. Return/navigation never invokes it. */
export async function submitAutomatedAttempt(
  input: AutomatedAttempt,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<AutomatedOutcome> {
  const current = () => isCurrent() && !signal?.aborted;
  let attempt = parseAutomatedAttempt(input);
  if (!current()) return { kind: 'unavailable' };
  if (!attempt || !saveAutomatedAttempt(attempt)) return { kind: 'refused' };
  const retained = restoreAutomatedAttempt();
  if (!retained || retained === 'invalid') return { kind: 'unavailable' };
  attempt = retained;
  const uncertain = !!(attempt.submitted || attempt.reference);
  const denied = await boundSession(attempt.accountId, signal);
  if (!current()) return { kind: 'unavailable' };
  if (denied) return uncertain && denied.kind === 'refused' ? { kind: 'unknown' } : denied;
  const { operation, operationKey, accountId } = attempt;
  let approvalExpiresAt = '';
  {
    attempt = parseAutomatedAttempt({ ...attempt, submitted: true })!;
    if (!saveAutomatedAttempt(attempt)) return { kind: 'unavailable' };
    if (!current()) return { kind: 'unavailable' };
    const approval = await boundedCommandPost(
      '/account-operations/approve',
      { operation, operationKey, accountId },
      automatedAccountOperationResponseByteBudgets.approval,
      signal,
    );
    if (!current()) return { kind: 'unavailable' };
    if (approval.kind !== 'response') return { kind: 'unknown' };
    if (approval.status !== 200) {
      const outcome = commandFailure('approve', approval.status, approval.body) ?? { kind: 'unknown' as const };
      return uncertain && outcome.kind === 'refused' ? { kind: 'unknown' } : outcome;
    }
    const admitted = approvalResponse(approval.body);
    if (!current()) return { kind: 'unavailable' };
    if (!admitted) return { kind: 'unknown' };
    approvalExpiresAt = admitted.expiresAt;
    attempt = parseAutomatedAttempt({ ...attempt, reference: admitted.reference })!;
    if (!saveAutomatedAttempt(attempt)) return { kind: 'unknown' };
  }
  if (!current()) return { kind: 'unavailable' };
  const sessionAfterApproval = await boundSession(accountId, signal);
  if (!current()) return { kind: 'unavailable' };
  if (sessionAfterApproval) return sessionAfterApproval.kind === 'refused' ? { kind: 'unknown' } : sessionAfterApproval;
  const expires = Date.parse(approvalExpiresAt);
  if (!current()) return { kind: 'unavailable' };
  if (!attempt.reference || !Number.isFinite(expires) || expires <= Date.now()) return { kind: 'unknown' };
  const result = await boundedCommandPost(
    '/account-operations/execute',
    { operation, operationKey, accountId, reference: attempt.reference },
    automatedAccountOperationResponseByteBudgets.execution,
    signal,
  );
  if (!current()) return { kind: 'unavailable' };
  if (result.kind !== 'response') return { kind: 'unknown' };
  if (result.status !== 200) {
    const outcome = commandFailure('execute', result.status, result.body);
    if (!outcome) return { kind: 'unknown' };
    return uncertain && outcome.kind === 'refused' ? { kind: 'unknown' } : outcome;
  }
  const acknowledgement = executionAcknowledgement(result.body);
  if (!acknowledgement) return { kind: 'unknown' };
  // Retain the immutable attempt even after success: navigation cannot accidentally
  // turn a lost acknowledgement into a new account/key. No automatic resubmit.
  return { kind: 'complete', accountId: acknowledgement.accountId };
}

/** Native sign-in materializes only existing current consent. No creation effect. */
export async function reauthenticateAutomated(
  accountId: string,
  email: string,
  password: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<AutomatedOutcome | null> {
  const current = () => isCurrent() && !signal?.aborted;
  const before = await loadManagementSession(signal);
  if (!current()) return { kind: 'unavailable' };
  if (before.kind !== 'ready' || before.accountId !== accountId) return { kind: 'refused' };
  const result = await submitSignIn('/signin', { email, password, ...AUTOMATED_PROFILE }, AUTOMATED_PROFILE);
  if (!current()) return { kind: 'unavailable' };
  if (!result.ok) return signInResult(result).reason === 'unavailable' ? { kind: 'unavailable' } : { kind: 'refused' };
  const sessionAfterSignIn = await boundSession(accountId, signal);
  return current() ? sessionAfterSignIn : { kind: 'unavailable' };
}
