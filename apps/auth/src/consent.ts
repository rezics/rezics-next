import { failureMessage, type AuthPostResult } from './api';

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
    const response = await fetch(`/consent/${encodeURIComponent(clientId)}`, {
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: signal ?? null,
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
  } catch {
    return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  }
}

export function approvedScopes(consent: Consent, requested: string[]): string[] {
  const registered = new Set(consent.scopes);
  return [...new Set([...consent.granted, ...requested.filter((scope) => registered.has(scope))])];
}
