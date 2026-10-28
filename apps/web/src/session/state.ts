import { configured, type SessionEnv } from './client.ts';
import { cookie, SESSION_COOKIE, validId } from './cookies.ts';

export type SessionState = 'signed-in' | 'signed-out' | 'unavailable';
export type SessionIdentity = { state: SessionState; subject?: string; csrfToken: string | null };

const identities = new WeakMap<Request, Promise<SessionIdentity>>();

export function readSessionIdentity(request: Request, env: Partial<SessionEnv>): Promise<SessionIdentity> {
  let pending = identities.get(request);
  if (!pending) {
    pending = resolveSessionIdentity(request, env);
    identities.set(request, pending);
  }
  return pending;
}

async function resolveSessionIdentity(request: Request, env: Partial<SessionEnv>): Promise<SessionIdentity> {
  if (!configured(env)) return { state: 'unavailable', csrfToken: null };
  try {
    const id = cookie(request, SESSION_COOKIE);
    if (!validId(id)) return { state: 'signed-out', csrfToken: null };
    const result = await env.SESSIONS.get(env.SESSIONS.idFromName(id)).signedIn();
    if (typeof result === 'string' && result) return { state: 'signed-in', subject: result, csrfToken: null };
    if (typeof result === 'boolean') return { state: result ? 'signed-in' : 'signed-out', csrfToken: null };
    return result.signedIn
      ? {
          state: 'signed-in',
          ...(result.subject ? { subject: result.subject } : {}),
          csrfToken: result.csrfToken,
        }
      : { state: 'signed-out', csrfToken: null };
  } catch {
    // Protected pages must show an error instead of starting a sign-in loop.
    return { state: 'unavailable', csrfToken: null };
  }
}

export async function readSessionState(request: Request, env: Partial<SessionEnv>): Promise<SessionIdentity> {
  return readSessionIdentity(request, env);
}
