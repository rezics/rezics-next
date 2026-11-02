import { privateAuthRead } from './private-auth-read';
import { authPost, failureMessage, type AuthPostResult } from './api';

export type Consent = {
  client_id: string;
  display_name: string | null;
  scopes: string[];
  granted: string[];
};

export type ConsentReview =
  | { state: 'loading' | 'signed-out' | 'not-found'; consent?: never; message?: never }
  | { state: 'ready'; consent: Consent; message?: never }
  | { state: 'failed'; consent?: never; message: string };

export type ConsentDecision = {
  state: ConsentReview['state'] | 'approved' | 'declined';
  consent?: Consent;
  message?: string;
  pending: boolean;
  uncertain: boolean;
};

// A visit owns its reads and writes. Storage carries only an uncertainty marker,
// never a cached review or an instruction to repeat a submission.
export function createConsentDecision(clientId: string, scope: string, publish: (value: ConsentDecision) => void) {
  const key = `auth.consent.pending:${JSON.stringify([clientId, scope])}`;
  let uncertain = false;
  try {
    uncertain = window.sessionStorage.getItem(key) === 'pending';
  } catch {
    // The mounted visit still protects results when browser storage is unavailable.
  }
  let current: ConsentDecision = { state: 'loading', pending: false, uncertain };
  let reader: ReturnType<typeof createConsentReview> | undefined;
  let disposed = false;
  function update(value: Omit<ConsentDecision, 'uncertain'>) {
    current = { ...value, uncertain };
    publish(current);
  }
  function remember(pending: boolean) {
    try {
      if (pending) window.sessionStorage.setItem(key, 'pending');
      else window.sessionStorage.removeItem(key);
    } catch {
      // Storage is optional; never let it prevent review or a deliberate decision.
    }
  }
  function restore() {
    if (disposed || reader) return;
    reader = createConsentReview(clientId, (review) => update({ ...review, pending: false }));
    void reader.load();
  }
  function suspend() {
    reader?.dispose();
    reader = undefined;
    if (current.pending) uncertain = true;
    update({ state: 'loading', pending: false });
  }
  return {
    restore,
    suspend,
    load() {
      if (!current.pending) void reader?.load();
    },
    async approve() {
      if (!reader || current.state !== 'ready' || !current.consent || current.pending) return;
      const owner = reader;
      const consent = current.consent;
      remember(true);
      update({ state: 'ready', consent, pending: true });
      const result = await authPost('/consent', {
        client_id: consent.client_id,
        scope: approvedScopes(consent, scope.split(/\s+/).filter(Boolean)),
      });
      if (disposed || owner !== reader) return;
      if (result.ok) {
        uncertain = false;
        remember(false);
        update({ state: 'approved', pending: false });
      } else {
        // A lost response or server failure cannot establish whether the write committed.
        uncertain ||= result.status >= 500;
        remember(uncertain);
        if (result.status === 401) update({ state: 'signed-out', pending: false });
        else if (result.status === 404) update({ state: 'not-found', pending: false });
        else
          update({
            state: 'ready',
            consent,
            pending: false,
            message: failureMessage(result.status, result.code, result.retryAfter),
          });
      }
    },
    decline() {
      if (reader && current.state === 'ready' && !current.pending) update({ state: 'declined', pending: false });
    },
    dispose() {
      disposed = true;
      reader?.dispose();
      reader = undefined;
    },
  };
}

// Each mounted request owns one reader. Retrying keeps that owner and its exact client;
// disposing it makes every outstanding result inert, including on a scope-only remount.
export function createConsentReview(clientId: string, publish: (review: ConsentReview) => void) {
  let active = true;
  let pending = false;
  let controller: AbortController | undefined;

  async function load() {
    // Lock before publishing loading: two activations in one render cannot overlap.
    if (!active || pending) return;
    if (!clientId) {
      publish({ state: 'not-found' });
      return;
    }
    pending = true;
    controller = new AbortController();
    publish({ state: 'loading' });
    const result = await readConsent(clientId, controller.signal);
    if (!active) return;
    pending = false;
    if (result.ok) publish({ state: 'ready', consent: result.body });
    else if (result.status === 401) publish({ state: 'signed-out' });
    else if (result.status === 404) publish({ state: 'not-found' });
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
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// This read is browser-only, on the issuer origin, just like the shared Auth writes.
export async function readConsent(clientId: string, signal?: AbortSignal): Promise<AuthPostResult<Consent>> {
  try {
    return await privateAuthRead(async (readSignal) => {
      const response = await fetch(`/consent/${encodeURIComponent(clientId)}`, {
        signal: readSignal,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 200) {
        if (
          !body ||
          typeof body !== 'object' ||
          !('client_id' in body) ||
          body.client_id !== clientId ||
          !('display_name' in body) ||
          (body.display_name !== null && typeof body.display_name !== 'string') ||
          !('scopes' in body) ||
          !stringArray(body.scopes) ||
          !('granted' in body) ||
          !stringArray(body.granted) ||
          !body.granted.every((scope) => (body.scopes as string[]).includes(scope))
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

export function approvedScopes(consent: Consent, requested: string[]): string[] {
  const registered = new Set(consent.scopes);
  return [...new Set([...consent.granted, ...requested.filter((scope) => registered.has(scope))])];
}
