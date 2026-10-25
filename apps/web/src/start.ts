import { createCsrfMiddleware, createMiddleware, createServerOnlyFn, createStart } from '@tanstack/react-start';
import { problem, problemResponse } from './media/kernel.ts';
import type { SessionEnv } from './session/client.ts';
import { cookie, SESSION_COOKIE, validId } from './session/cookies.ts';
import {
  carriesSession,
  csrfTokenFromRequest,
  csrfTokenMatches,
  isAllowedSiteOrigin,
  isUnsafeRequest,
} from './session/csrf.ts';

const forbidden = () => problemResponse(problem(403, 'forbidden', 'Forbidden'));
const needsCsrf = (request: Request) => isUnsafeRequest(request) && carriesSession(request);
const isAllowedOrigin = createServerOnlyFn(async (request: Request, origin: string | null) => {
  const { env } = await import('cloudflare:workers');
  return isAllowedSiteOrigin(request, origin, (env as Partial<SessionEnv>).SITE_ORIGINS);
});
const validatesSessionToken = createServerOnlyFn(async (request: Request) => {
  const { env } = await import('cloudflare:workers');
  const sessionEnv = env as Partial<SessionEnv>;
  const id = cookie(request, SESSION_COOKIE);
  const supplied = await csrfTokenFromRequest(request);
  if (!validId(id) || supplied === null || !sessionEnv.SESSIONS) return false;
  try {
    const result = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).signedIn();
    const signedIn = typeof result === 'boolean' ? result : result.signedIn;
    const token = typeof result === 'boolean' ? undefined : (result.csrfToken ?? undefined);
    return signedIn && csrfTokenMatches(token, supplied);
  } catch {
    return false;
  }
});

const originMiddleware = createCsrfMiddleware({
  filter: ({ request }) => needsCsrf(request),
  origin: (origin, { request }) => isAllowedOrigin(request, origin),
  // The Fetch Metadata header never substitutes for the exact Origin allowlist.
  secFetchSite: (_site, { request }) => isAllowedOrigin(request, request.headers.get('origin')),
  referer: false,
  allowRequestsWithoutOriginCheck: false,
  failureResponse: forbidden,
});

const tokenMiddleware = createMiddleware().server(async ({ request, next }) => {
  if (!needsCsrf(request)) return next();
  if (!(await validatesSessionToken(request))) return forbidden();
  return next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [originMiddleware, tokenMiddleware] }));
