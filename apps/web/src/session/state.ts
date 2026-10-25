import { configured, type SessionEnv } from './client.ts';
import { cookie, SESSION_COOKIE, validId } from './cookies.ts';

export type SessionState = 'signed-in' | 'signed-out' | 'unavailable';
export type SessionIdentity = { state: SessionState; subject?: string };

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
  if (!configured(env)) return { state: 'unavailable' };
  try {
    const id = cookie(request, SESSION_COOKIE);
    if (!validId(id)) return { state: 'signed-out' };
    const result = await env.SESSIONS.get(env.SESSIONS.idFromName(id)).signedIn();
    if (typeof result === 'string' && result) return { state: 'signed-in', subject: result };
    return result ? { state: 'signed-in' } : { state: 'signed-out' };
  } catch {
    // A page remains usable when the local session cannot be read.
    return { state: 'signed-out' };
  }
}

export async function readSessionState(request: Request, env: Partial<SessionEnv>): Promise<SessionState> {
  return (await readSessionIdentity(request, env)).state;
}
