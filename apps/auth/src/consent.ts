import { privateAuthRead } from './private-auth-read';
import { authPost, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';

export type Consent = {
  client_id: string;
  display_name: string | null;
  scopes: string[];
  requested: string[];
  granted: string[];
  pending_reduction: boolean;
  acting_account: { account_id: string; email: string | null };
  decisions: { allow: boolean; decline: boolean; switch_account: boolean };
};

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
};

const markerPrefix = 'auth.consent.pending:';
const maxScopes = 1000;
const maxScopeQueryBytes = 8192;
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const encoder = new TextEncoder();

// A visit owns its reads and writes. Storage contains only an uncertainty marker;
// the legacy unscoped marker stays unresolved because it cannot be assigned safely.
export function createConsentDecision(clientId: string, scope: string, publish: (value: ConsentDecision) => void) {
  const legacyKey = `${markerPrefix}${JSON.stringify([clientId, scope])}`;
  let accountKey: string | undefined;
  let uncertain = false;
  let unattributedUncertain = false;
  try {
    unattributedUncertain = window.sessionStorage.getItem(legacyKey) === 'pending';
  } catch {
    // The mounted visit still protects results when browser storage is unavailable.
  }
  let current: ConsentDecision = { state: 'loading', pending: false, uncertain, unattributedUncertain };
  let reader: ReturnType<typeof createConsentReview> | undefined;
  let disposed = false;

  function update(value: Omit<ConsentDecision, 'uncertain' | 'unattributedUncertain'>) {
    current = { ...value, uncertain, unattributedUncertain };
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
    accountKey = key;
    try {
      uncertain = window.sessionStorage.getItem(key) === 'pending';
    } catch {
      uncertain = false;
    }
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
    reader?.dispose();
    reader = undefined;
    if (current.pending) {
      uncertain = true;
      remember(accountKey, true);
    }
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
      const submitted = approvedScopes(consent, consent.requested);
      remember(submittedKey, true);
      update({ state: 'ready', consent, pending: true });
      const result = await authPost<unknown>('/consent', {
        client_id: consent.client_id,
        scope: submitted,
        reviewed_account_id: consent.acting_account.account_id,
        reviewed_scopes: [...consent.granted],
        reviewed_requested: [...consent.requested],
      });
      const acknowledged = result.ok ? parseConsentDecisionResponse(result.body, consent, submitted) : null;
      if (acknowledged) {
        // A positive response identifies this action only. It cannot resolve an older unknown write.
        remember(submittedKey, priorUncertainty);
        if (disposed || owner !== reader) return;
        uncertain = priorUncertainty;
        update({ state: 'approved', consent, approved: acknowledged, pending: false });
        return;
      }
      const uncertainAfter = priorUncertainty || (result.ok ? true : result.status >= 500);
      remember(submittedKey, uncertainAfter);
      if (disposed || owner !== reader) return;
      uncertain = uncertainAfter;
      if (!result.ok && result.status === 401) update({ state: 'signed-out', pending: false });
      else if (!result.ok && result.status === 404) update({ state: 'not-found', pending: false });
      else if (!result.ok && result.status === 409 && result.code === 'stale_review') {
        update({ state: 'failed', pending: false, message: m.auth_consent_stale_review() });
      } else
        update({
          state: 'ready',
          consent,
          pending: false,
          message: result.ok
            ? failureMessage(503, 'unavailable', null)
            : failureMessage(result.status, result.code, result.retryAfter),
        });
    },
    decline() {
      if (reader && current.state === 'ready' && current.consent?.decisions.decline && !current.pending)
        update({ state: 'declined', consent: current.consent, pending: false });
    },
    dispose() {
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
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 128 && scopePattern.test(item),
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
  if (values.length > maxScopes || values.some((value) => value.length > 128 || !scopePattern.test(value))) return null;
  return [...new Set(values)];
}

// Browser GET is same-origin through Auth's private page boundary and never accepts redirects.
export async function readConsent(
  clientId: string,
  signal?: AbortSignal,
  requestedScope = '',
): Promise<AuthPostResult<Consent>> {
  const requested = requestedScopeSet(requestedScope);
  if (!requested) return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
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
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 200) {
        if (
          !record(body) ||
          keys(body) !== 'acting_account,client_id,decisions,display_name,granted,pending_reduction,requested,scopes' ||
          body.client_id !== clientId ||
          (body.display_name !== null && (typeof body.display_name !== 'string' || body.display_name.length > 100)) ||
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
          body.acting_account.account_id.length > 1024 ||
          (body.acting_account.email !== null &&
            (typeof body.acting_account.email !== 'string' ||
              body.acting_account.email.length > 254 ||
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

function parseConsentDecisionResponse(value: unknown, consent: Consent, expected: string[]): string[] | null {
  if (
    !record(value) ||
    keys(value) !== 'account_id,client_id,requested,scope' ||
    value.client_id !== consent.client_id ||
    value.account_id !== consent.acting_account.account_id ||
    !stringArray(value.requested) ||
    !sameScopes(value.requested, consent.requested) ||
    !stringArray(value.scope) ||
    !sameScopes(value.scope, expected)
  )
    return null;
  return [...value.scope];
}
