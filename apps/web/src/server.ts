import { env } from 'cloudflare:workers';
import { authRequest } from './session/routes.ts';
import { prepareSession } from './session/request.ts';
import { cookie, clearCookie, SESSION_COOKIE, validId } from './session/cookies.ts';
import type { SessionEnv } from './session/client.ts';
import { readSessionIdentity } from './session/state.ts';
import { sessionSubject } from './session/request.ts';
import {
  carriesSession,
  csrfTokenFromRequest,
  csrfTokenMatches,
  isAllowedSiteOrigin,
  isUnsafeRequest,
} from './session/csrf.ts';
import { problem, problemResponse } from './media/kernel.ts';
import { mediaRequest, type MediaEnv } from './media/index.ts';
import { robotsResponse } from './sitemap/robots.ts';
import { sitemapResponse, type SitemapEnv } from './sitemap/serve.ts';
import { suggestSubjects } from './search/suggestions.ts';
import { limitRead, readLimitKey, type ReadRateLimitEnv } from './rate-limit/read.ts';
import { orderStatusResponse } from './checkout/order.server.ts';
import { startCheckout } from './checkout/start.ts';
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import {
  defineCustomServerStrategy,
  extractLocaleFromRequestAsync,
  extractLocaleFromRequestWithStrategies,
  localizeUrl,
  locales,
} from './paraglide/runtime.js';

export { SessionStore } from './session/store.ts';

defineCustomServerStrategy('custom-accept-language', {
  getLocale(request) {
    if (!request) return undefined;
    try {
      return extractLocaleFromRequestWithStrategies(request, ['url', 'cookie']);
    } catch {
      // Continue to the custom header strategy when neither runtime strategy matches.
    }
    return matchUiLocaleTag(request.headers.get('accept-language'));
  },
});

const fetchHandler = createStartHandler(defaultStreamHandler);
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    // Sitemaps and robots.txt read no session and make no kernel request.
    const publicEnv = env as Partial<SitemapEnv> & { PUBLIC_ORIGIN?: string };
    const crawlerFile =
      robotsResponse(request, { origin: publicEnv.PUBLIC_ORIGIN ?? '', locales }) ??
      (await sitemapResponse(request, publicEnv));
    if (crawlerFile) return crawlerFile;
    const sessionEnv = env as Partial<SessionEnv>;
    if (
      isUnsafeRequest(request) &&
      carriesSession(request) &&
      !isAllowedSiteOrigin(request, request.headers.get('origin'), sessionEnv.SITE_ORIGINS)
    )
      return problemResponse(problem(403, 'forbidden', 'Forbidden'));
    const orderStatus = /^\/orders\/([^/]+)\/status$/.exec(url.pathname);
    if (orderStatus && request.method === 'GET') {
      try {
        await prepareSession(request, sessionEnv);
        const refused = await limitRead(
          request,
          env as typeof env & ReadRateLimitEnv,
          readLimitKey(request, sessionSubject(request)),
        );
        if (refused) return refused;
        return await orderStatusResponse(request, orderStatus[1]!);
      } catch (error) {
        return problemResponse(error);
      }
    }
    if (url.pathname === '/checkout') {
      if (request.method !== 'POST')
        return problemResponse(problem(405, 'invalid_request', 'Invalid Request'), { allow: 'POST' });
      try {
        return await startCheckout(request, sessionEnv);
      } catch (error) {
        return problemResponse(error);
      }
    }
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const isMedia = url.pathname === '/media' || url.pathname.startsWith('/media/');
    if (isRead && !isMedia && !url.pathname.startsWith('/auth/') && url.pathname !== '/api/search/suggestions') {
      const redirect = await pageRedirect(request, url);
      if (redirect) return redirect;
    }
    let clearSessionCookie = false;
    let mediaSessionError: unknown;

    if (isRead) {
      let subject: string | undefined;
      if (isMedia) {
        try {
          clearSessionCookie = await prepareSession(request, env as Partial<SessionEnv>);
        } catch (error) {
          mediaSessionError = error;
        }
        subject = sessionSubject(request);
      } else if (!url.pathname.startsWith('/auth/') && url.pathname !== '/') {
        subject = (await readSessionIdentity(request, env as Partial<SessionEnv>)).subject;
      }

      const refused = await limitRead(request, env as typeof env & ReadRateLimitEnv, readLimitKey(request, subject));
      if (refused) return refused;
      if (mediaSessionError !== undefined) return problemResponse(mediaSessionError);
    }

    if (url.pathname.startsWith('/auth/')) {
      if (isUnsafeRequest(request) && carriesSession(request)) {
        const id = cookie(request, SESSION_COOKIE);
        const token = await csrfTokenFromRequest(request);
        if (url.pathname === '/auth/sign-out') {
          if (!validId(id) || !sessionEnv.SESSIONS) return problemResponse(problem(403, 'forbidden', 'Forbidden'));
          try {
            const ended = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).end(token);
            if (typeof ended !== 'object' || ended === null || !ended.allowed)
              return problemResponse(problem(403, 'forbidden', 'Forbidden'));
            return authRequest(request, sessionEnv, { idToken: ended.idToken });
          } catch (error) {
            return problemResponse(error);
          }
        }
        if (!validId(id) || !sessionEnv.SESSIONS || token === null)
          return problemResponse(problem(403, 'forbidden', 'Forbidden'));
        try {
          const result = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).signedIn();
          const signedIn = typeof result === 'object' ? result.signedIn : Boolean(result);
          const csrfToken = typeof result === 'object' ? (result.csrfToken ?? undefined) : undefined;
          if (!signedIn || !csrfTokenMatches(csrfToken, token))
            return problemResponse(problem(403, 'forbidden', 'Forbidden'));
        } catch {
          return problemResponse(problem(403, 'forbidden', 'Forbidden'));
        }
      }
      return authRequest(request, sessionEnv);
    }
    if (url.pathname === '/api/search/suggestions') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } });
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query || query.length > 256)
        return Response.json(
          { subjects: [], as_of: new Date().toISOString() },
          { headers: { 'cache-control': 'no-store' } },
        );
      try {
        return Response.json(await suggestSubjects(query, request), { headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json(
          { error: 'Suggestions unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
    }
    if (url.pathname !== '/media' && !url.pathname.startsWith('/media/')) return siteRequest(request);
    try {
      if (!isRead) clearSessionCookie = await prepareSession(request, env as Partial<SessionEnv>);
      const response = await mediaRequest(request, env as Partial<MediaEnv>);
      if (!clearSessionCookie) return response;
      const headers = new Headers(response.headers);
      headers.append('set-cookie', clearCookie(SESSION_COOKIE));
      headers.set('cache-control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return problemResponse(error);
    }
  },
};

async function pageRedirect(request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    return new Response(null, { status: 301, headers: { Location: url.href } });
  }
  const first = url.pathname.split('/')[1];
  if (!locales.some((locale) => locale === first)) {
    const locale = await extractLocaleFromRequestAsync(request);
    const location = localizeUrl(url, { locale });
    return new Response(null, {
      status: 302,
      headers: { Location: location.href, Vary: 'Cookie, Accept-Language', 'Cache-Control': 'private, no-store' },
    });
  }
}

async function siteRequest(request: Request): Promise<Response> {
  return paraglideMiddleware(request, () => fetchHandler(request)).then((response: Response) => {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

function matchUiLocaleTag(header: string | null): string | undefined {
  const entries = (header ?? '').split(',').map((part, index) => ({
    tag: part.split(';')[0]!.trim().toLowerCase(),
    index,
    quality: Number(/;\s*q=([0-9.]+)/i.exec(part)?.[1] ?? 1),
  }));
  entries.sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const { tag, quality } of entries) {
    if (quality <= 0) continue;
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split('-');
    if (language === 'zh')
      return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return undefined;
}
