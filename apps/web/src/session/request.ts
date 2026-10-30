import { dependencyUnavailable, problem } from '../media/kernel.ts';
import { assertPublicCacheReadAllowed } from '../security/page-cache.ts';
import { configured, type SessionEnv } from './client.ts';
import { cookie, SESSION_COOKIE, validId } from './cookies.ts';
import {
  carriesSession,
  csrfTokenFromRequest,
  csrfTokenMatches,
  isAllowedSiteOrigin,
  isUnsafeRequest,
} from './csrf.ts';

const credentials = new WeakMap<Request, string>();
const subjects = new WeakMap<Request, string>();
const csrfTokens = new WeakMap<Request, string>();

// Credential-using routes resolve before their first kernel call, outside any error
// concealment. Page requests need no lookup. The boolean clears stale cookies.
export async function prepareSession(
  request: Request,
  env: Partial<SessionEnv>,
  options: { refresh?: boolean } = {},
): Promise<boolean> {
  assertPublicCacheReadAllowed(request, 'session');
  const id = cookie(request, SESSION_COOKIE);
  if (id === undefined) return false;
  const requireCsrf = isUnsafeRequest(request) && carriesSession(request);
  if (requireCsrf && !isAllowedSiteOrigin(request, request.headers.get('origin'), env.SITE_ORIGINS))
    throw problem(403, 'forbidden', 'Forbidden');
  if (!configured(env)) {
    if (requireCsrf) throw problem(403, 'forbidden', 'Forbidden');
    return false;
  }
  if (!validId(id)) {
    if (requireCsrf) throw problem(403, 'forbidden', 'Forbidden');
    return true;
  }
  const explicitAuthorization = request.headers.has('authorization');
  if (explicitAuthorization && !requireCsrf) return false;

  if (requireCsrf && explicitAuthorization) {
    const session = await env.SESSIONS.get(env.SESSIONS.idFromName(id)).signedIn();
    const signedIn = typeof session === 'boolean' ? session : session.signedIn;
    const csrfToken = typeof session === 'boolean' ? null : session.csrfToken;
    if (!signedIn || !csrfTokenMatches(csrfToken ?? undefined, await csrfTokenFromRequest(request)))
      throw problem(403, 'forbidden', 'Forbidden');
    return false;
  }

  const store = env.SESSIONS.get(env.SESSIONS.idFromName(id));
  const result = options.refresh === false ? await store.credentialIfFresh() : await store.credential();
  if (requireCsrf) {
    const csrfToken = result.status === 'active' || result.status === 'unavailable' ? result.csrfToken : undefined;
    if (result.status === 'absent' || !csrfTokenMatches(csrfToken, await csrfTokenFromRequest(request)))
      throw problem(403, 'forbidden', 'Forbidden');
  }
  if (result.status === 'unavailable') throw dependencyUnavailable();
  if (result.status === 'absent') return true;
  credentials.set(request, `Bearer ${result.accessToken}`);
  subjects.set(request, result.subject);
  csrfTokens.set(request, result.csrfToken);
  return false;
}

export function sessionSubject(request: Request): string | undefined {
  assertPublicCacheReadAllowed(request, 'session');
  return subjects.get(request);
}

export function viewerCredential(request: Request): string | null {
  assertPublicCacheReadAllowed(request, 'session credential');
  return request.headers.get('authorization') ?? credentials.get(request) ?? null;
}

export function requestCsrfToken(request: Request): string | null {
  return csrfTokens.get(request) ?? null;
}
