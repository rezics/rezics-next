import {
  CONSENT_PAGE_MAX_SCOPES as maxScopes,
  CONSENT_PAGE_MAX_SCOPE_QUERY_BYTES as maxScopeQueryBytes,
  CONSENT_PAGE_MAX_SCOPE_LENGTH,
  CONSENT_PAGE_MAX_ID_LENGTH,
  CONSENT_PAGE_MAX_DISPLAY_NAME_LENGTH,
  CONSENT_PAGE_MAX_EMAIL_LENGTH,
  CONSENT_PAGE_MAX_RESPONSE_BYTES,
  CONSENT_PAGE_MAX_ERROR_BYTES,
  CONSENT_DECISION_MAX_RESPONSE_BYTES,
  CONSENT_DECISION_MAX_ERROR_BYTES,
  type ReviewedConsentDecisionResponse,
  type ConsentDecisionErrorResponse,
  type ConsentPageResponse,
} from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { privateAuthRead } from './private-auth-read';
import { AUTH_POST_TIMEOUT_MS, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import type { ConsentOutcome } from './consent-request-return';

export type Consent = ConsentPageResponse;

export type ConsentReview =
  | { state: 'loading' | 'signed-out' | 'not-found'; consent?: never; message?: never }
  | { state: 'ready'; consent: Consent; message?: never }
  | { state: 'failed'; consent?: never; message: string };

export type ConsentDecision = {
  state: ConsentReview['state'] | 'approved' | 'declined';
  consent?: Consent;
  approved?: string[];
  message?: string;
  pending: boolean;
  uncertain: boolean;
  unattributedUncertain: boolean;
  history: 'none' | 'acknowledged' | 'unknown';
};

const markerPrefix = 'auth.consent.pending:';
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const encoder = new TextEncoder();

// A visit owns its reads and writes. Storage contains only an uncertainty marker;
// the legacy unscoped marker stays unresolved because it cannot be assigned safely.
export function createConsentDecision(
  clientId: string,
  scope: string,
  publish: (value: ConsentDecision) => void,
  outcome: (value: ConsentOutcome) => void = () => {},
) {
  const legacyKey = `${markerPrefix}${JSON.stringify([clientId, scope])}`;
  let accountKey: string | undefined;
  let uncertain = false;
  let unattributedUncertain = false;
  // Request-local caution survives account replacement; generic presentation is owned by the page.
  let history: ConsentDecision['history'] = 'none';
  try {
    unattributedUncertain = window.sessionStorage.getItem(legacyKey) === 'pending';
  } catch {
    // The mounted visit still protects results when browser storage is unavailable.
  }
  if (unattributedUncertain) outcome('unattributed');
  let current: ConsentDecision = { state: 'loading', pending: false, uncertain, unattributedUncertain, history };
  let reader: ReturnType<typeof createConsentReview> | undefined;
  let activeSend: { controller: AbortController; dispatched: boolean } | undefined;
  let disposed = false;

  function update(value: Omit<ConsentDecision, 'uncertain' | 'unattributedUncertain' | 'history'>) {
    current = { ...value, uncertain, unattributedUncertain, history };
    publish(current);
  }
  function remember(key: string | undefined, pending: boolean) {
    if (!key) return;
    try {
      if (pending) window.sessionStorage.setItem(key, 'pending');
      else window.sessionStorage.removeItem(key);
    } catch {
      // Storage is optional; never let it prevent review or a deliberate decision.
    }
  }
  function bindAccount(accountId: string) {
    const key = `${markerPrefix}${JSON.stringify([accountId, clientId, scope])}`;
    if (key === accountKey) return;
    retainHistory();
    accountKey = key;
    try {
      uncertain = window.sessionStorage.getItem(key) === 'pending';
    } catch {
      uncertain = false;
    }
    if (uncertain) outcome('unknown');
  }
  function retainHistory() {
    if ((current.pending && activeSend?.dispatched) || uncertain) history = 'unknown';
    else if (current.state === 'approved' && history !== 'unknown') history = 'acknowledged';
  }
  function restore() {
    if (disposed || reader) return;
    reader = createConsentReview(clientId, scope, (review) => {
      if (review.state === 'ready') bindAccount(review.consent.acting_account.account_id);
      update({ ...review, pending: false });
    });
    void reader.load();
  }
  function suspend() {
    if (disposed) return;
    retainHistory();
    reader?.dispose();
    reader = undefined;
    if (current.pending && activeSend?.dispatched) {
      uncertain = true;
      remember(accountKey, true);
      outcome('unknown');
    }
    activeSend?.controller.abort();
    activeSend = undefined;
    update({ state: 'loading', pending: false });
  }
  return {
    restore,
    suspend,
    refresh() {
      suspend();
      restore();
    },
    load() {
      if (!current.pending) void reader?.load();
    },
    shouldWarn() {
      return current.pending || uncertain || unattributedUncertain || history === 'unknown';
    },
    async approve() {
      const consent = current.consent;
      if (
        !reader ||
        current.state !== 'ready' ||
        !consent ||
        current.pending ||
        !consent.decisions.allow ||
        !accountKey
      )
        return;
      const owner = reader;
      const submittedKey = accountKey;
      const priorUncertainty = uncertain;
      const reviewedAccountId = consent.acting_account.account_id;
      const reviewedClientId = consent.client_id;
      const reviewedScopes = Object.freeze([...consent.granted]);
      const reviewedRequested = Object.freeze([...consent.requested]);
      const submitted = Object.freeze(approvedScopes(consent, [...reviewedRequested]));
      const controller = new AbortController();
      const sending = { controller, dispatched: false };
      activeSend = sending;
      update({ state: 'ready', consent, pending: true });
      const body = Object.freeze({
        client_id: reviewedClientId,
        scope: submitted,
        reviewed_account_id: reviewedAccountId,
        reviewed_scopes: reviewedScopes,
        reviewed_requested: reviewedRequested,
      });
      const result = await submitConsentDecision(body, controller.signal, () => {
        sending.dispatched = true;
        remember(submittedKey, true);
      });
      // Retired callbacks cannot clear a marker now owned by a newer attempt, or
      // replace the generic history captured when their private review retired.
      if (disposed || owner !== reader) return;
      if (activeSend === sending) activeSend = undefined;
      if (result.kind === 'acknowledged') {
        // A positive response identifies this action only. It cannot resolve an older unknown write.
        remember(submittedKey, priorUncertainty);
        uncertain = priorUncertainty;
        if (priorUncertainty) history = 'unknown';
        else if (history !== 'unknown') history = 'acknowledged';
        update({ state: 'approved', consent, approved: result.approved, pending: false });
        outcome('acknowledged');
        return;
      }
      if (result.kind === 'not-dispatched') {
        remember(submittedKey, priorUncertainty);
        uncertain = priorUncertainty;
        if (priorUncertainty) history = 'unknown';
        update({
          state: 'ready',
          consent,
          pending: false,
          message: failureMessage(503, 'unavailable', null),
        });
        return;
      }
      const refused = result.kind === 'refused';
      const uncertainAfter = priorUncertainty || !refused;
      remember(submittedKey, uncertainAfter);
      uncertain = uncertainAfter;
      if (uncertainAfter) history = 'unknown';
      // Classify this reply separately from older unresolved work.
      outcome(refused ? 'refused' : 'unknown');
      if (result.status === 401) update({ state: 'signed-out', pending: false });
      else if (result.status === 404) update({ state: 'not-found', pending: false });
      else if (refused && result.status === 409 && result.code === 'stale_review') {
        update({ state: 'failed', pending: false, message: m.auth_consent_stale_review() });
      } else
        update({
          state: 'ready',
          consent,
          pending: false,
          message:
            result.status === 429 && result.code === 'authentication_denied' && result.retryAfter !== null
              ? m.auth_failure_retry_after({ seconds: result.retryAfter })
              : failureMessage(result.status, result.code, result.retryAfter),
        });
    },
    decline() {
      if (reader && current.state === 'ready' && current.consent?.decisions.decline && !current.pending) {
        update({ state: 'declined', consent: current.consent, pending: false });
        outcome('declined');
      }
    },
    dispose() {
      // Retirement captures an in-flight result before relinquishing ownership.
      if (!disposed) suspend();
      disposed = true;
      reader?.dispose();
      reader = undefined;
    },
  };
}

// Each mounted request owns one reader. Retrying keeps its exact client and scope;
// disposing it makes every outstanding read inert.
export function createConsentReview(clientId: string, scope: string, publish: (review: ConsentReview) => void) {
  let active = true;
  let pending = false;
  let controller: AbortController | undefined;

  async function load() {
    if (!active || pending) return;
    if (!clientId) {
      publish({ state: 'not-found' });
      return;
    }
    pending = true;
    controller = new AbortController();
    publish({ state: 'loading' });
    const result = await readConsent(clientId, controller.signal, scope);
    if (!active) return;
    pending = false;
    if (result.ok) publish({ state: 'ready', consent: result.body });
    else if (result.status === 401) publish({ state: 'signed-out' });
    else if (result.status === 404) publish({ state: 'not-found' });
    else if (result.status === 409 && result.code === 'stale_review')
      publish({ state: 'failed', message: m.auth_consent_stale_review() });
    else {
      publish({
        state: 'failed',
        message: failureMessage(result.status, result.code, result.retryAfter),
      });
    }
  }

  return {
    load,
    dispose() {
      active = false;
      controller?.abort();
    },
  };
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxScopes &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= CONSENT_PAGE_MAX_SCOPE_LENGTH &&
        scopePattern.test(item),
    ) &&
    new Set(value).size === value.length
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}
function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}
function requestedScopeSet(scope: string): string[] | null {
  if (encoder.encode(scope).byteLength > maxScopeQueryBytes) return null;
  const trimmed = scope.replace(/^ +| +$/gu, '');
  if (!trimmed) return [];
  const values = trimmed.split(/ +/u);
  if (
    values.length > maxScopes ||
    values.some((value) => value.length > CONSENT_PAGE_MAX_SCOPE_LENGTH || !scopePattern.test(value))
  )
    return null;
  return [...new Set(values)];
}

// Browser GET is same-origin through Auth's private page boundary and never accepts redirects.
export async function readConsent(
  clientId: string,
  signal?: AbortSignal,
  requestedScope = '',
): Promise<AuthPostResult<Consent>> {
  const requested = requestedScopeSet(requestedScope);
  if (!clientId || clientId.length > CONSENT_PAGE_MAX_ID_LENGTH || !requested)
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  try {
    return await privateAuthRead(async (readSignal) => {
      const query = new URLSearchParams({ scope: requestedScope });
      const response = await fetch(
        `/consent/${encodeURIComponent(clientId)}${requestedScope === '' ? '' : `?${query.toString()}`}`,
        {
          signal: readSignal,
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
        },
      );
      const body = await readJsonBounded(
        response,
        response.status === 200 ? CONSENT_PAGE_MAX_RESPONSE_BYTES : CONSENT_PAGE_MAX_ERROR_BYTES,
        readSignal,
      );
      if (response.status === 200) {
        if (
          !record(body) ||
          keys(body) !== 'acting_account,client_id,decisions,display_name,granted,pending_reduction,requested,scopes' ||
          body.client_id !== clientId ||
          (body.display_name !== null &&
            (typeof body.display_name !== 'string' ||
              body.display_name.length > CONSENT_PAGE_MAX_DISPLAY_NAME_LENGTH)) ||
          !stringArray(body.scopes) ||
          !stringArray(body.requested) ||
          !sameScopes(body.requested, requested) ||
          !stringArray(body.granted) ||
          !body.granted.every((scope) => (body.scopes as string[]).includes(scope)) ||
          typeof body.pending_reduction !== 'boolean' ||
          !record(body.acting_account) ||
          keys(body.acting_account) !== 'account_id,email' ||
          typeof body.acting_account.account_id !== 'string' ||
          !body.acting_account.account_id ||
          body.acting_account.account_id.length > CONSENT_PAGE_MAX_ID_LENGTH ||
          (body.acting_account.email !== null &&
            (typeof body.acting_account.email !== 'string' ||
              body.acting_account.email.length > CONSENT_PAGE_MAX_EMAIL_LENGTH ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.acting_account.email))) ||
          !record(body.decisions) ||
          keys(body.decisions) !== 'allow,decline,switch_account' ||
          typeof body.decisions.allow !== 'boolean' ||
          body.decisions.allow === body.pending_reduction ||
          body.decisions.decline !== true ||
          body.decisions.switch_account !== true
        )
          throw new Error('Invalid consent response');
        return { ok: true, body: body as Consent };
      }
      const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : '';
      const header = response.headers.get('Retry-After');
      return { ok: false, status: response.status, code, retryAfter: header && /^\d+$/.test(header) ? header : null };
    }, signal);
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

export function approvedScopes(consent: Consent, requested: string[] = consent.requested): string[] {
  const registered = new Set(consent.scopes);
  return [...new Set([...consent.granted, ...requested.filter((scope) => registered.has(scope))])];
}

type ConsentDecisionSubmissionResult =
  | { kind: 'acknowledged'; approved: string[] }
  | { kind: 'refused'; status: number; code: string; retryAfter: string | null }
  | { kind: 'unknown'; status: number; code: string; retryAfter: string | null }
  | { kind: 'not-dispatched' };

function unknownConsentReply(status: number, retryAfter: string | null): ConsentDecisionSubmissionResult {
  return { kind: 'unknown', status, code: 'unavailable', retryAfter };
}

/** Narrow Allow transport: one issuer POST and one five-second lifetime through its bounded response body. */
async function submitConsentDecision(
  body: Readonly<{
    client_id: string;
    scope: readonly string[];
    reviewed_account_id: string;
    reviewed_scopes: readonly string[];
    reviewed_requested: readonly string[];
  }>,
  caller: AbortSignal,
  onDispatch: () => void,
): Promise<ConsentDecisionSubmissionResult> {
  const serialized = JSON.stringify(body);
  const controller = new AbortController();
  let dispatched = false;
  let resolveStopped!: (result: ConsentDecisionSubmissionResult) => void;
  const stopped = new Promise<ConsentDecisionSubmissionResult>((resolve) => {
    resolveStopped = resolve;
  });
  const onAbort = () => resolveStopped(dispatched ? unknownConsentReply(503, null) : { kind: 'not-dispatched' });
  const onCallerAbort = () => controller.abort(caller.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (caller.aborted) onCallerAbort();
  else caller.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Consent decision timed out', 'TimeoutError')),
    AUTH_POST_TIMEOUT_MS,
  );

  const send = async (): Promise<ConsentDecisionSubmissionResult> => {
    controller.signal.throwIfAborted();
    dispatched = true;
    onDispatch();
    let response: Response;
    try {
      response = await fetch('/consent', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
        signal: controller.signal,
      });
    } catch {
      return unknownConsentReply(503, null);
    }
    const header = response.headers.get('Retry-After');
    const retryAfter = header && /^\d+$/u.test(header) ? header : null;
    let value: unknown;
    try {
      value = await readJsonBounded(
        response,
        response.status === 200 ? CONSENT_DECISION_MAX_RESPONSE_BYTES : CONSENT_DECISION_MAX_ERROR_BYTES,
        controller.signal,
      );
    } catch {
      return unknownConsentReply(response.status, retryAfter);
    }
    if (response.status === 200) {
      const approved = parseConsentDecisionResponse(
        value,
        body.client_id,
        body.reviewed_account_id,
        body.reviewed_requested,
        body.scope,
      );
      return approved ? { kind: 'acknowledged', approved } : unknownConsentReply(200, retryAfter);
    }
    const refusal = parseConsentDecisionError(response.status, value);
    if (refusal && isKnownConsentRefusal(response.status, refusal)) {
      const code = 'code' in refusal ? refusal.code : refusal.error;
      return { kind: 'refused', status: response.status, code, retryAfter };
    }
    return {
      kind: 'unknown',
      status: response.status,
      code: refusal ? consentErrorCode(refusal) : 'unavailable',
      retryAfter,
    };
  };

  try {
    return await Promise.race([send(), stopped]);
  } finally {
    clearTimeout(timer);
    caller.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

function consentErrorCode(error: ConsentDecisionErrorResponse): string {
  return 'code' in error ? error.code : error.error;
}

export function isKnownConsentRefusal(status: number, error: ConsentDecisionErrorResponse): boolean {
  if (status === 409 && error.error === 'authentication_denied' && 'code' in error)
    return error.code === 'stale_review';
  if (status === 401 && error.error === 'step_up_required') return error.effect_status === 'not_applied';
  if (status === 403 && error.error === 'account_suspended') return error.code === 'ACCOUNT_SUSPENDED';
  // Generic request, origin, size and attempt-limit refusals happen before the
  // writer can begin a grant or reduction. Generic 401/404 may be returned
  // after native barrier progress, so keep those account markers unresolved.
  return [400, 403, 413, 415, 429].includes(status) && error.error === 'authentication_denied' && !('code' in error);
}

export function parseConsentDecisionError(status: number, value: unknown): ConsentDecisionErrorResponse | null {
  if (!record(value)) return null;
  if (value.error === 'authentication_denied') {
    if (keys(value) === 'error') return { error: 'authentication_denied' };
    if (status === 409 && keys(value) === 'code,error' && value.code === 'stale_review')
      return { error: 'authentication_denied', code: 'stale_review' };
  }
  if (
    status === 401 &&
    keys(value) === 'effect_status,error' &&
    value.error === 'step_up_required' &&
    value.effect_status === 'not_applied'
  )
    return { error: 'step_up_required', effect_status: 'not_applied' };
  if (
    status === 403 &&
    keys(value) === 'code,error' &&
    value.error === 'account_suspended' &&
    value.code === 'ACCOUNT_SUSPENDED'
  )
    return { error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' };
  return null;
}

function parseConsentDecisionResponse(
  value: unknown,
  clientId: string,
  accountId: string,
  requested: readonly string[],
  expected: readonly string[],
): string[] | null {
  if (
    !record(value) ||
    keys(value) !== 'account_id,client_id,requested,scope' ||
    value.client_id !== clientId ||
    value.account_id !== accountId ||
    !stringArray(value.requested) ||
    !sameScopes(value.requested, requested) ||
    !stringArray(value.scope) ||
    !sameScopes(value.scope, expected)
  )
    return null;
  return [...(value as unknown as ReviewedConsentDecisionResponse).scope];
}
