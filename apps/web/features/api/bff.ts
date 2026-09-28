import { BFF_PREFIX } from './browser.ts';
import { sameOriginWrite } from './origins.ts';

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
export function mainTarget(segments: readonly string[], search: string, mainOrigin: string): URL | null {
  if (segments[0] !== 'v1' || segments.length < 2 || segments.length > MAX_SEGMENTS) return null;
  if (segments.some(item => !segment.test(item) || item === '.' || item === '..')) return null;
  return new URL(`/${segments.join('/')}${search}`, mainOrigin);
}

/** Request headers Main reads; cookies and anything else stay behind. */
export const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type',
  'idempotency-key', 'if-match', 'if-none-match', 'if-range', 'range', 'x-session-key',
  'x-rezics-display-languages'] as const;

/** Response headers a browser caller needs. */
export const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-language',
  'content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified',
  'location', 'retry-after', 'www-authenticate'] as const;

export function mainRequestHeaders(incoming: Headers, accessToken: string | undefined): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return headers;
}

export function browserResponseHeaders(upstream: Headers, mainOrigin: string): Headers {
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
  // browser must never reuse one across sign-out or Agent switches.
  headers.set('cache-control', 'no-store');
  return headers;
}

/** Forwards one browser request to Main and streams both bodies. */
export async function forwardToMain(request: Request, segments: readonly string[], input: {
  mainOrigin: string; accessToken: string | undefined; fetch?: typeof fetch;
}): Promise<Response> {
  const target = mainTarget(segments, new URL(request.url).search, input.mainOrigin);
  if (!target) return Response.json({ error: 'unknown API path' }, { status: 404 });
  if (!(MAIN_METHODS as readonly string[]).includes(request.method)) {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }
  if (request.method !== 'GET' && !sameOriginWrite(request)) {
    return Response.json({ error: 'origin mismatch' }, { status: 403 });
  }
  const body = request.method === 'GET' ? undefined : request.body;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(target, { method: request.method,
      headers: mainRequestHeaders(request.headers, input.accessToken), body,
      ...(body ? { duplex: 'half' } : {}), redirect: 'manual', cache: 'no-store' } as RequestInit);
  } catch {
    return Response.json({ error: 'Main is unavailable' }, { status: 503, headers: { 'retry-after': '5' } });
  }
  return new Response(response.body, { status: response.status,
    headers: browserResponseHeaders(response.headers, input.mainOrigin) });
}
