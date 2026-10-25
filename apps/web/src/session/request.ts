import { dependencyUnavailable } from '../media/kernel.ts';
import { configured, type SessionEnv } from './client.ts';
import { cookie, SESSION_COOKIE, validId } from './cookies.ts';

const credentials = new WeakMap<Request, string>();

// Credential-using routes resolve before their first kernel call, outside any error
// concealment. Page requests need no lookup. The boolean clears stale cookies.
export async function prepareSession(request: Request, env: Partial<SessionEnv>): Promise<boolean> {
  const id = cookie(request, SESSION_COOKIE);
  if (id === undefined || !configured(env) || request.headers.has('authorization')) return false;
  if (!validId(id)) return true;
  const result = await env.SESSIONS.get(env.SESSIONS.idFromName(id)).credential();
  if (result.status === 'unavailable') throw dependencyUnavailable();
  if (result.status === 'absent') return true;
  credentials.set(request, `Bearer ${result.accessToken}`);
  return false;
}

export function viewerCredential(request: Request): string | null {
  return request.headers.get('authorization') ?? credentials.get(request) ?? null;
}
