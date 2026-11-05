import { createServerFn } from '@tanstack/react-start';
import {
  ACCOUNT_OPERATION_MAX_ERROR_BYTES,
  isAccountOperationReference,
  isManagementOperation,
  isOperatorPageId,
  isOperatorPageVersion,
  OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES,
  parseAccountOperationRefusal,
  securityResponseByteBudgets,
  securityResponseLimits,
  managementOperationProfile,
  type ManagementOperationInput,
  type SessionProof,
} from '@rezics/auth-contract';
import { approveManagementOperation } from './management-operations';
import { markManagementOpeningSubmitted } from './management-operation-step-up';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';
import { readSecurityIssuerResponse, trustedSecurityResponseConfiguration } from './security-response-config';

export type OpeningInput = ManagementOperationInput & {
  operation: { kind: 'opening'; operatorAccountId: string; subjectAccountId: string };
};
type LegacyOpeningIdentity = {
  id: string;
  kind: 'actor' | 'organization' | null;
  handle: string | null;
  displayName: string | null;
};
type LegacyOpeningMetadata = { subject: LegacyOpeningIdentity; operator: LegacyOpeningIdentity };
type LegacyOpeningRead = { kind: 'ready'; metadata: LegacyOpeningMetadata } | { kind: 'unavailable' };
export type OpeningIdentity = { id: string; kind: 'actor' | 'organization'; publicLabel: null };
export type OpeningMetadata = {
  viewer: { accountId: string; publicLabel: null };
  subject: OpeningIdentity;
  operator: OpeningIdentity;
  relation: { reservationId: string; version: string };
};
export type OpeningOutcome =
  | { kind: 'opened'; session: SessionProof }
  | { kind: 'refused' | 'step-up' | 'unavailable' | 'unknown' };
export type OpeningRead =
  | { kind: 'ready'; metadata: OpeningMetadata }
  | { kind: 'refused' | 'step-up' | 'unavailable' };
export type OperatorOpeningIssueInput = { input: OpeningInput; reference: string };

function isOperatorOpeningIssueInput(value: unknown): value is OperatorOpeningIssueInput {
  return (
    record(value) &&
    fields(value, ['input', 'reference']) &&
    isOpeningInput(value.input) &&
    isAccountOperationReference(value.reference)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;
}
function identity(value: unknown): value is LegacyOpeningIdentity {
  return (
    record(value) &&
    fields(value, ['id', 'kind', 'handle', 'displayName']) &&
    id(value.id) &&
    (value.kind === 'actor' || value.kind === 'organization') &&
    (value.handle === null || typeof value.handle === 'string') &&
    (value.displayName === null || typeof value.displayName === 'string')
  );
}
export function isOpeningInput(value: unknown): value is OpeningInput {
  return (
    record(value) &&
    fields(value, ['accountId', 'operationKey', 'operation']) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= securityResponseLimits.id &&
    text(value.operationKey) &&
    isManagementOperation(value.operation) &&
    value.operation.kind === 'opening' &&
    id(value.operation.operatorAccountId) &&
    id(value.operation.subjectAccountId)
  );
}
/** The native management point read already enforces active account, disclosure
 * and current operator management. Its real relation distinguishes an operated
 * actor from a human; URL IDs, self/role names and public profiles do not. */
export function parseOpeningMetadata(value: unknown, input: OpeningInput): LegacyOpeningRead {
  if (
    !record(value) ||
    !fields(value, ['account', 'self', 'role', 'operator', 'relation', 'members', 'responsibilities']) ||
    !identity(value.account) ||
    value.account.kind !== 'actor' ||
    value.account.id !== input.operation.subjectAccountId ||
    !identity(value.operator) ||
    value.operator.id !== input.operation.operatorAccountId ||
    !record(value.relation) ||
    !fields(value.relation, ['operatorAccountId', 'reservationId', 'version']) ||
    value.relation.operatorAccountId !== value.operator.id ||
    !id(value.relation.reservationId) ||
    typeof value.relation.version !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.relation.version)
  )
    return { kind: 'unavailable' };
  return { kind: 'ready', metadata: { subject: { ...value.account }, operator: { ...value.operator } } };
}
/** The delivered private relation source and authorized identity projection must
 * describe the same native tuple. Neither observation supplies opening approval. */
export function parseOpeningSource(value: unknown, relation: unknown, input: OpeningInput): LegacyOpeningRead {
  const metadata = parseOpeningMetadata(value, input);
  if (
    metadata.kind !== 'ready' ||
    !record(value) ||
    !record(value.relation) ||
    !record(relation) ||
    !fields(relation, ['previous', 'expectedVersion']) ||
    !record(relation.previous) ||
    !fields(relation.previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) ||
    relation.previous.subjectAccountId !== input.operation.subjectAccountId ||
    relation.previous.operatorAccountId !== input.operation.operatorAccountId ||
    relation.previous.reservationId !== value.relation.reservationId ||
    relation.expectedVersion !== value.relation.version
  )
    return { kind: 'unavailable' };
  return metadata;
}
/** Native source IDs suffice for confirmation. It verifies the operated actor;
 * it does not disclose the operator's kind, handle or display name. */
export function parseOpeningRelation(value: unknown, input: OpeningInput): LegacyOpeningRead {
  if (
    !record(value) ||
    !fields(value, ['previous', 'expectedVersion']) ||
    !record(value.previous) ||
    !fields(value.previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) ||
    value.previous.subjectAccountId !== input.operation.subjectAccountId ||
    value.previous.operatorAccountId !== input.operation.operatorAccountId ||
    !id(value.previous.reservationId) ||
    typeof value.expectedVersion !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.expectedVersion)
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    metadata: {
      subject: { id: value.previous.subjectAccountId, kind: 'actor', handle: null, displayName: null },
      operator: { id: value.previous.operatorAccountId, kind: null, handle: null, displayName: null },
    },
  };
}
function openingPageIdentity(value: unknown, kind: 'actor' | 'organization'): value is { id: string; kind: string } {
  return record(value) && fields(value, ['id', 'kind']) && isOperatorPageId(value.id) && value.kind === kind;
}
/** The native page observation is closed and advice-only. No private identifier
 * is reused as a public identity label when native disclosure is unavailable. */
export function parseOperatorOpeningPage(value: unknown, input: OpeningInput): OpeningRead {
  if (
    !record(value) ||
    !fields(value, ['stage', 'viewer', 'subject', 'operator', 'relation', 'disclosure', 'allowedActions']) ||
    value.stage !== 'current' ||
    !record(value.viewer) ||
    !fields(value.viewer, ['accountId']) ||
    typeof value.viewer.accountId !== 'string' ||
    !value.viewer.accountId ||
    value.viewer.accountId.length > securityResponseLimits.id ||
    value.viewer.accountId !== input.accountId ||
    !openingPageIdentity(value.subject, 'actor') ||
    value.subject.id !== input.operation.subjectAccountId ||
    !record(value.operator) ||
    !fields(value.operator, ['id', 'kind']) ||
    !isOperatorPageId(value.operator.id) ||
    value.operator.id !== input.operation.operatorAccountId ||
    (value.operator.kind !== 'actor' && value.operator.kind !== 'organization') ||
    !record(value.relation) ||
    !fields(value.relation, ['reservationId', 'version']) ||
    !isOperatorPageId(value.relation.reservationId) ||
    !isOperatorPageVersion(value.relation.version) ||
    value.disclosure !== 'unavailable' ||
    !Array.isArray(value.allowedActions) ||
    value.allowedActions.length !== 1 ||
    value.allowedActions[0] !== 'opening'
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    metadata: {
      viewer: { accountId: value.viewer.accountId, publicLabel: null },
      subject: { id: value.subject.id, kind: 'actor', publicLabel: null },
      operator: { id: value.operator.id, kind: value.operator.kind, publicLabel: null },
      relation: { reservationId: value.relation.reservationId, version: value.relation.version },
    },
  };
}

export function sameOpeningPage(left: OpeningMetadata, right: OpeningMetadata): boolean {
  return (
    left.viewer.accountId === right.viewer.accountId &&
    left.subject.id === right.subject.id &&
    left.subject.kind === right.subject.kind &&
    left.operator.id === right.operator.id &&
    left.operator.kind === right.operator.kind &&
    left.relation.reservationId === right.relation.reservationId &&
    left.relation.version === right.relation.version
  );
}

export async function requestOperatorOpeningPage(
  input: OpeningInput,
  request: Request,
  issuer: string,
): Promise<OpeningRead> {
  try {
    return await privateAuthRead(async (signal) => {
      const origin = new URL(request.url).origin;
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.get('origin') !== origin && request.headers.get('origin') !== issuer)
      )
        return { kind: 'unavailable' };
      const response = await fetch(new URL('/account-management/operators/opening-page', issuer), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: issuer,
          Cookie: request.headers.get('cookie') ?? '',
        },
        body: JSON.stringify({
          subjectAccountId: input.operation.subjectAccountId,
          operatorAccountId: input.operation.operatorAccountId,
        }),
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
      const body = await readJsonBounded(response, OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES, signal);
      if (response.status === 200) return parseOperatorOpeningPage(body, input);
      if (response.status === 401 && record(body) && fields(body, ['stage']) && body.stage === 'step-up')
        return { kind: 'step-up' };
      if ([400, 403].includes(response.status) && record(body) && fields(body, ['stage']) && body.stage === 'refused')
        return { kind: 'refused' };
      return { kind: 'unavailable' };
    }, request.signal);
  } catch {
    return { kind: 'unavailable' };
  }
}

const nativeOpeningPage = createServerFn({ method: 'POST' })
  .validator((value: unknown): OpeningInput => {
    if (!isOpeningInput(value)) throw new Error('Invalid opening');
    return value;
  })
  .handler(async ({ data }): Promise<OpeningRead> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const request = getRequest();
      const origin = new URL(request.url).origin;
      const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
      return await requestOperatorOpeningPage(data, request, issuer);
    } catch {
      return { kind: 'unavailable' };
    }
  });
export const operatorOpeningBrowserTransport = {
  metadata: (input: OpeningInput, signal: AbortSignal) => nativeOpeningPage({ data: input, signal }),
  session: (input: OpeningInput, signal: AbortSignal) => nativeOpenedSession({ data: input, signal }),
  issue: (issue: OperatorOpeningIssueInput, signal: AbortSignal) =>
    nativeOperatorSessionIssue({ data: issue, signal }),
};
export async function loadOpeningMetadata(input: OpeningInput, signal?: AbortSignal): Promise<OpeningRead> {
  if (!isOpeningInput(input)) return { kind: 'unavailable' };
  try {
    return await privateAuthRead((readSignal) => operatorOpeningBrowserTransport.metadata(input, readSignal), signal);
  } catch {
    return { kind: 'unavailable' };
  }
}
/** Automated proofs are displayed separately and never fed to the human-only
 * loadManagementSession. Scopes are exactly the native receipt's bound scopes. */
export function openedSession(value: unknown, input: OpeningInput): SessionProof | null {
  if (
    !record(value) ||
    !fields(value, ['account_id', 'client_id', 'scope', 'authn_epoch', 'auth_time', 'amr']) ||
    value.account_id !== input.operation.subjectAccountId ||
    value.client_id !== managementOperationProfile('opening').client_id ||
    !Array.isArray(value.amr) ||
    value.amr.length !== 1 ||
    value.amr[0] !== 'operator' ||
    !Array.isArray(value.scope) ||
    !value.scope.every((scope) => typeof scope === 'string') ||
    !Number.isSafeInteger(value.authn_epoch) ||
    (value.authn_epoch as number) < 0 ||
    !Number.isSafeInteger(value.auth_time) ||
    (value.auth_time as number) < 0 ||
    (value.auth_time as number) > Math.floor(Date.now() / 1000)
  )
    return null;
  return value as unknown as SessionProof;
}

/** The issued proof bound uses the native mounted catalogue and exact requested profile. */
export function operatorOpeningSessionResponseBudget(scopeCatalogueLimit: number) {
  const requestedScopeLimit = managementOperationProfile('opening').scope.length;
  const scopeLimit = Math.min(scopeCatalogueLimit, requestedScopeLimit);
  const sessionBytes = securityResponseByteBudgets(scopeLimit).session;
  return { scopeLimit, maxBytes: Math.max(sessionBytes, ACCOUNT_OPERATION_MAX_ERROR_BYTES) };
}

/** Receive one native issuance reply. Cookies are forwarded before body projection, even
 * when a malformed or excess body leaves the effect unknown. */
export async function receiveOperatorOpeningSessionResponse(
  response: Response,
  input: OpeningInput,
  scopeCatalogueLimit: number,
  forwardSetCookies?: (cookies: string[]) => void,
  signal?: AbortSignal,
): Promise<OpeningOutcome> {
  const cookies = response.headers.getSetCookie();
  if (cookies.length) forwardSetCookies?.(cookies);
  const { scopeLimit, maxBytes } = operatorOpeningSessionResponseBudget(scopeCatalogueLimit);
  let body: unknown;
  try {
    body = await readJsonBounded(response, maxBytes, signal ?? new AbortController().signal);
  } catch {
    return { kind: 'unknown' };
  }
  if (response.status === 200) {
    const outcome = parseOpenedSessionObservation(body, input, scopeLimit);
    const requestedScopes = managementOperationProfile('opening').scope;
    if (
      outcome.kind !== 'opened' ||
      outcome.session.scope.length !== requestedScopes.length ||
      !outcome.session.scope.every((scope, index) => scope === requestedScopes[index])
    )
      return { kind: 'unknown' };
    return outcome;
  }
  const refusal = parseAccountOperationRefusal(body, response.status);
  if (refusal?.error === 'step_up_required') return { kind: 'step-up' };
  if (refusal?.error === 'account_operation_denied' && response.status !== 503) return { kind: 'refused' };
  return { kind: 'unknown' };
}

function raceAbort<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** One native issuance request. The caller's privateAuthRead signal owns its five-second
 * lifetime through issuer headers, bounded body parsing and BFF completion. */
export async function requestOperatorOpeningSession(
  issue: OperatorOpeningIssueInput,
  request: Request,
  issuer: string,
  scopeCatalogueLimit: number,
  forwardSetCookies: (cookies: string[]) => void,
): Promise<OpeningOutcome> {
  const origin = new URL(request.url).origin;
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (request.headers.get('origin') !== origin && request.headers.get('origin') !== issuer)
  )
    return { kind: 'unknown' };
  const signal = request.signal;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await raceAbort(
      signal,
      fetch(new URL('/operator-sessions/open', issuer), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: issuer,
          Cookie: request.headers.get('cookie') ?? '',
        },
        body: JSON.stringify({
          ...issue.input,
          reference: issue.reference,
        }),
        redirect: 'manual',
        cache: 'no-store',
        signal,
      }),
    );
  } catch {
    return { kind: 'unknown' };
  }
  return receiveOperatorOpeningSessionResponse(
    response,
    issue.input,
    scopeCatalogueLimit,
    forwardSetCookies,
    signal,
  );
}
/** The readback admits the full native proof, independently of human advice.
 * Issuance acknowledgement retains its command parser above. */
export function parseOpenedSessionObservation(value: unknown, input: OpeningInput, scopeLimit: number): OpeningOutcome {
  if (
    !record(value) ||
    typeof value.account_id !== 'string' ||
    !value.account_id ||
    value.account_id.length > securityResponseLimits.id ||
    typeof value.client_id !== 'string' ||
    !value.client_id ||
    value.client_id.length > securityResponseLimits.id ||
    !Array.isArray(value.scope) ||
    value.scope.length > scopeLimit ||
    !value.scope.every((scope) => typeof scope === 'string' && scope.length <= securityResponseLimits.scope)
  )
    return { kind: 'unknown' };
  const session = openedSession(value, input);
  return session ? { kind: 'opened', session } : { kind: 'unknown' };
}
const nativeOpenedSession = createServerFn({ method: 'POST' })
  .validator((value: unknown): OpeningInput => {
    if (!isOpeningInput(value)) throw new Error('Invalid opening');
    return value;
  })
  .handler(async ({ data }): Promise<OpeningOutcome> => {
    const configuration = await trustedSecurityResponseConfiguration();
    if (!configuration) return { kind: 'unknown' };
    return readSecurityIssuerResponse('/session', undefined, async (response, signal) => {
      if (response.status !== 200) return { kind: 'unknown' };
      return parseOpenedSessionObservation(
        await readJsonBounded(response, configuration.sessionBytes, signal),
        data,
        configuration.scopeLimit,
      );
    });
  });

const nativeOperatorSessionIssue = createServerFn({ method: 'POST' })
  .validator((value: unknown): OperatorOpeningIssueInput => {
    if (!isOperatorOpeningIssueInput(value)) throw new Error('Invalid opening issuance');
    return value;
  })
  .handler(async ({ data }): Promise<OpeningOutcome> => {
    const configuration = await trustedSecurityResponseConfiguration();
    if (!configuration) return { kind: 'unknown' };
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    const request = getRequest();
    const origin = new URL(request.url).origin;
    const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
    setResponseHeader('Cache-Control', 'private, no-store');
    return requestOperatorOpeningSession(data, request, issuer, configuration.scopeLimit, (cookies) => {
      setResponseHeader('Set-Cookie', cookies);
    });
  });
/** Read only: never renew cached metadata, replay issuance, restore a human
 * cookie, or treat readback as evidence that this request created the session. */
export async function readOpenedSession(input: OpeningInput, signal?: AbortSignal): Promise<OpeningOutcome> {
  try {
    return await privateAuthRead((readSignal) => operatorOpeningBrowserTransport.session(input, readSignal), signal);
  } catch {
    return { kind: 'unknown' };
  }
}
/** Explicit second submit only. The approval reference exists solely in this
 * request stack. Unlike mutations, ambiguous issuance is never retried. */
export async function submitOperatorOpening(
  input: OpeningInput,
  isCurrent: () => boolean = () => true,
  onPhase?: (phase: 'approval' | 'possibly-sent' | 'acknowledged' | 'unconfirmed' | 'refused') => void,
  signal?: AbortSignal,
): Promise<OpeningOutcome> {
  if (!isOpeningInput(input)) return { kind: 'refused' };
  onPhase?.('approval');
  const approved = await approveManagementOperation(input, 'opening', isCurrent, signal);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (approved.kind !== 'approved') return approved;
  const snapshot = approved.input;
  if (!isOpeningInput(snapshot)) return { kind: 'refused' };
  if (!markManagementOpeningSubmitted(snapshot)) return { kind: 'unavailable' };
  onPhase?.('possibly-sent');
  let result: OpeningOutcome;
  try {
    result = await privateAuthRead(
      (readSignal) => operatorOpeningBrowserTransport.issue({ input: snapshot, reference: approved.reference }, readSignal),
      signal,
    );
  } catch {
    result = { kind: 'unknown' };
  }
  if (!isCurrent()) return { kind: 'unavailable' };
  onPhase?.(result.kind === 'unknown' ? 'unconfirmed' : result.kind === 'opened' ? 'acknowledged' : 'refused');
  return result;
}
