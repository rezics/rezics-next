import { configured, type SessionEnv } from './client.ts';
import { cookie, SESSION_COOKIE, validId } from './cookies.ts';

export type SessionState = 'signed-in' | 'signed-out' | 'unavailable';

export async function readSessionState(request: Request, env: Partial<SessionEnv>): Promise<SessionState> {
  if (!configured(env)) return 'unavailable';
  try {
    const id = cookie(request, SESSION_COOKIE);
    if (!validId(id)) return 'signed-out';
    return (await env.SESSIONS.get(env.SESSIONS.idFromName(id)).signedIn()) ? 'signed-in' : 'signed-out';
  } catch {
    // A page remains usable when the local session cannot be read.
    return 'signed-out';
  }
}
