import { forwardClientIp } from './main-read.ts';
import { SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { CONTENT_LANGUAGES_COOKIE, displayLanguageHeaders } from '../../i18n/display-languages.ts';
import { BFF_PREFIX } from './browser.ts';
import { sameOriginWrite } from './origins.ts';
import {
  serverFetch,
  deadlineFromHeaders,
  SERVER_READ_LIMITS,
  waitForServerRead,
} from './server-fetch.ts';
import { mainBodyRead } from './main-read-operation.ts';

// The BFF forwards `/api/main/<Main path>` to Main with the session's bearer
// token. It keeps Main's path shape, so the browser Eden client uses the same
// `MainApp` type as the server one.

/** Every HTTP method Main's router registers (WebSocket upgrades are not proxied). */
export const MAIN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// Main's literal segments and parameters (UUIDs, slugs, `work.create`) are all
// RFC 3986 unreserved characters. `.` and `..` are rejected so no path can
// leave `/v1`; the longest Main route has 9 segments.
const segment = /^[A-Za-z0-9._~-]{1,200}$/;
const MAX_SEGMENTS = 16;

/** The Main URL for a BFF path, or null when Main could not route it. */
export function mainTarget(
  segments: readonly string[],
  search: string,
  mainOrigin: string,
): URL | null {
  if (segments[0] !== 'v1' || segments.length < 2 || segments.length > MAX_SEGMENTS) return null;
  if (segments.some((item) => !segment.test(item) || item === '.' || item === '..')) return null;
  return new URL(`/${segments.join('/')}${search}`, mainOrigin);
}

/** Request headers Main reads; cookies and anything else stay behind. */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'if-range',
  'range',
  'x-session-key',
  'x-rezics-display-languages',
] as const;

/** Response headers a browser caller needs. */
export const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-language',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'www-authenticate',
] as const;

export function mainRequestHeaders(
  incoming: Headers,
  accessToken: string | undefined,
  clientIpHeader = 'cf-connecting-ip',
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  forwardClientIp(incoming, headers, clientIpHeader);
  return headers;
}

/**
 * Media bytes are the same in every language. Main labels them public only when it decided without
 * any reader identity (`services/main/src/routes/media.ts`), so those keep its revalidating policy.
 */
const mediaRead = (method: string, segments: readonly string[]) =>
  method === 'GET' && segments[1] === 'media';

export function browserResponseHeaders(upstream: Headers, mainOrigin: string, media = false): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  const location = headers.get('location');
  if (location) {
    const target = new URL(location, mainOrigin);
    if (target.origin === mainOrigin && target.pathname.startsWith('/v1/')) {
      headers.set('location', `${BFF_PREFIX}${target.pathname}${target.search}`);
    }
  }
  // Responses depend on the session cookie and Main's ETags do not, so a
  // browser must never reuse one across sign-out or Agent switches. Public
  // media is the exception: no reader decided it, and each reuse revalidates.
  const cacheControl = upstream.get('cache-control');
  headers.set('cache-control', media && /^public\b/.test(cacheControl ?? '') ? cacheControl! : 'no-store');
  return headers;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const item = part.trim();
    const split = item.indexOf('=');
    if (split > 0 && item.slice(0, split) === name) return item.slice(split + 1);
  }
  return null;
}

const readingLanguageCache = new Map<string, { at: number; languages: string[] }>();
const READING_LANGUAGE_CACHE_MS = 2_000;

function cachedReadingLanguages(token: string): string[] | null {
  const hit = readingLanguageCache.get(token);
  if (!hit || Date.now() - hit.at > READING_LANGUAGE_CACHE_MS) return null;
  return hit.languages;
}

function rememberReadingLanguages(token: string, languages: string[]) {
  if (readingLanguageCache.size > 64) {
    const oldest = readingLanguageCache.keys().next().value;
    if (oldest) readingLanguageCache.delete(oldest);
  }
  readingLanguageCache.set(token, { at: Date.now(), languages });
}

/** Main's ordered reading languages for a signed-in browser call. Never the cookie. */
async function signedInReadingLanguages(
  mainOrigin: string,
  accessToken: string,
  sessionKey: string,
  fetchImpl: typeof fetch,
  clientHeaders: Headers,
  deadlineAt?: number,
): Promise<string[]> {
  const cached = cachedReadingLanguages(accessToken);
  if (cached) return cached;
  try {
    const headers = new Headers();
    const clientIp = clientHeaders.get('x-rezics-client-ip');
    if (clientIp) headers.set('x-rezics-client-ip', clientIp);
    headers.set('authorization', `Bearer ${accessToken}`);
    if (sessionKey) headers.set('x-session-key', sessionKey);
    const session = await serverFetch(
      `${mainOrigin}/v1/me/session-agent`,
      { headers },
      { fetch: fetchImpl, deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata },
    );
    if (!session.ok) return [];
    const state = (await session.json()) as {
      sessionAgent?: { actingSubject?: string; eligible?: boolean };
    };
    const actor = state.sessionAgent?.eligible ? state.sessionAgent.actingSubject : null;
    if (!actor) return [];
    headers.delete('x-session-key');
    const preferences = await serverFetch(
      `${mainOrigin}/v1/me/person-preferences?actingSubject=${encodeURIComponent(actor)}`,
      { headers },
      { fetch: fetchImpl, deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata },
    );
    if (!preferences.ok) return [];
    const value = (await preferences.json()) as { contentLanguages?: unknown };
    const languages = Array.isArray(value.contentLanguages)
      ? value.contentLanguages.filter(
          (language): language is string => typeof language === 'string',
        )
      : [];
    rememberReadingLanguages(accessToken, languages);
    return languages;
  } catch {
    return [];
  }
}

function forgetReadingLanguages(token: string | undefined) {
  if (token) readingLanguageCache.delete(token);
}

/** Replaces whatever display-language headers the browser sent. */
async function applyDisplayLanguages(
  request: Request,
  headers: Headers,
  input: {
    mainOrigin: string;
    accessToken: string | undefined;
    fetch: typeof fetch;
    segments: readonly string[];
    /** A preferences write must not cache the list it is about to replace. */
    writing: boolean;
    deadlineAt: number;
  },
): Promise<void> {
  const lookup =
    input.segments[1] === 'me' &&
    (input.segments[2] === 'session-agent' || input.segments[2] === 'person-preferences');
  const signedIn = Boolean(input.accessToken);
  const profile =
    signedIn && !lookup && !input.writing
      ? await signedInReadingLanguages(
          input.mainOrigin,
          input.accessToken!,
          cookieValue(request.headers.get('cookie'), SESSION_KEY_COOKIE) ?? '',
          input.fetch,
          headers,
          input.deadlineAt,
        )
      : [];
  const languageHeaders = displayLanguageHeaders({
    signedIn,
    profile,
    cookie: cookieValue(request.headers.get('cookie'), CONTENT_LANGUAGES_COOKIE),
    pageUrl: request.headers.get('x-rezics-page-url'),
    browser: request.headers.get('accept-language'),
  });
  headers.delete('accept-language');
  headers.delete('x-rezics-display-languages');
  for (const [name, value] of Object.entries(languageHeaders)) headers.set(name, value);
}

/** Forwards one browser request; JSON completes within the deadline and media keeps backpressure. */
export async function forwardToMain(
  request: Request,
  segments: readonly string[],
  input: {
    mainOrigin: string;
    accessToken: string | undefined;
    fetch?: typeof fetch;
    clientIpHeader?: string;
  },
): Promise<Response> {
  const target = mainTarget(segments, new URL(request.url).search, input.mainOrigin);
  if (!target) return Response.json({ error: 'unknown API path' }, { status: 404 });
  if (!(MAIN_METHODS as readonly string[]).includes(request.method)) {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }
  if (request.method !== 'GET' && !sameOriginWrite(request)) {
    return Response.json({ error: 'origin mismatch' }, { status: 403 });
  }
  const bodyRead = mainBodyRead(target.pathname, request.method);
  const body = request.method === 'GET' ? undefined : request.body;
  const writesLanguages =
    request.method === 'PUT' &&
    (segments[2] === 'person-preferences' || segments[2] === 'feed-preferences');
  const fetchImpl = input.fetch ?? fetch;
  const deadlineAt = deadlineFromHeaders(request.headers) ?? Date.now() + SERVER_READ_LIMITS.page;
  const headers = mainRequestHeaders(request.headers, input.accessToken, input.clientIpHeader);
  const media = mediaRead(request.method, segments);
  // A signed-in reader's languages cost Main two session reads; no media read uses them.
  if (!media)
    await applyDisplayLanguages(request, headers, {
      ...input,
      fetch: fetchImpl,
      segments,
      writing: writesLanguages,
      deadlineAt,
    });
  let response: Response;
  try {
    // Body-bearing reads use a replayable JSON string. Writes retain streaming
    // upload bodies and are never automatically replayed.
    response = await serverFetch(
      target,
      {
        method: request.method,
        headers,
        body: bodyRead ? await waitForServerRead(request.text(), deadlineAt) : body,
        signal: request.signal,
        ...(body ? { duplex: 'half' } : {}),
        redirect: 'manual',
        cache: 'no-store',
      } as RequestInit,
      {
        fetch: fetchImpl,
        deadlineAt,
        idempotentRead: bodyRead,
        timeoutMs:
          segments[1] === 'media' && !bodyRead
            ? SERVER_READ_LIMITS.transfer
            : SERVER_READ_LIMITS.read,
        stream: (upstream) =>
          Boolean(upstream.headers.get('content-type')) &&
          !upstream.headers.get('content-type')!.includes('json'),
      },
    );
  } catch {
    return Response.json(
      { error: 'Main is unavailable' },
      { status: 503, headers: { 'retry-after': '5' } },
    );
  }
  if (writesLanguages && response.ok) forgetReadingLanguages(input.accessToken);
  return new Response(response.status === 304 ? null : response.body, {
    status: response.status,
    headers: browserResponseHeaders(response.headers, input.mainOrigin, media),
  });
}
