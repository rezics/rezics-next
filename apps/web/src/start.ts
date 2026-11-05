import { createCsrfMiddleware, createMiddleware, createServerOnlyFn, createStart } from '@tanstack/react-start';
import { securityHeaders, viteNonceMarker } from './security/headers.ts';
import { createNonce } from './security/nonce.ts';
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
const sharedSubjectRatingForm = (request: Request) =>
  request.method === 'POST' &&
  request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded' &&
  /^\/(?:de|en|es|fr|ja|ko|zh-Hans|zh-Hant)\/subjects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]{1,128}$/i.test(
    new URL(request.url).pathname,
  );
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
  // Public subject HTML cannot carry a reader-specific token. Its HTML form is protected by the exact Origin
  // allowlist above and the handler only accepts this bounded subject rating form.
  if (!needsCsrf(request) || sharedSubjectRatingForm(request)) return next();
  if (!(await validatesSessionToken(request))) return forbidden();
  return next();
});

const pageSecurity = createMiddleware().server(async ({ request, next }) => {
  const nonce = createNonce(request);
  const result = await next();
  if (!result.response.headers.get('content-type')?.includes('text/html')) return result;
  const { env } = await import('cloudflare:workers');
  const headers = new Headers(result.response.headers);
  securityHeaders(request, nonce, (env as Partial<SessionEnv>).AUTH_ISSUER ?? '', import.meta.env.DEV).forEach(
    (value, name) => headers.set(name, value),
  );
  let response = new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers,
  });
  if (import.meta.env.DEV) {
    // Only Vite's explicitly marked assets are trusted; never bless unnonced content.
    response = new HTMLRewriter()
      .on('script, style, link, meta[property="csp-nonce"]', {
        element(element) {
          if (
            element.getAttribute('nonce') === viteNonceMarker ||
            (element.tagName === 'meta' && element.getAttribute('content') === nonce)
          )
            element.setAttribute('nonce', nonce);
        },
      })
      .transform(response);
  }
  return { ...result, response };
});

export const startInstance = createStart(() => ({
  requestMiddleware: [pageSecurity, originMiddleware, tokenMiddleware],
}));
