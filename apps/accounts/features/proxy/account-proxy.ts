// The Accounts site is the public Account origin. It forwards the Account
// service's public surface, so Better Auth's session cookie is first-party here
// and never set on a product origin. Products reach Account through this origin
// too; only Main talks to the service directly for JWKS and introspection.

const prefixes = ['/api/auth/', '/api/account/', '/oauth2/', '/.well-known/'];
const segment = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,256}$/;
// `x-account-reason` is the audit reason Account requires for operator changes.
const requestHeaders = ['accept', 'accept-language', 'authorization', 'content-type', 'cookie',
  'dpop', 'user-agent', 'x-account-reason'];
const fetchMetadata = ['sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
const bodyless = new Set(['GET', 'HEAD']);

export interface AccountProxyOptions {
  /** Where the Account service listens, e.g. http://127.0.0.1:3002. */
  serviceOrigin: string;
  /** The public Account origin the service trusts (its ACCOUNT_BASE_URL). */
  publicOrigin: string;
  fetch?: typeof fetch;
}

/** Paths this origin forwards to the Account service instead of rendering. */
export function isAccountServicePath(pathname: string): boolean {
  return prefixes.some(prefix => pathname.startsWith(prefix));
}

function sameOrigin(value: string | null, origin: string): boolean {
  if (!value) return false;
  try { return new URL(value).origin === origin; } catch { return false; }
}

/** Replace `own` with `target` as the origin of an absolute URL header value. */
function reorigin(value: string, own: string, target: string): string {
  const url = new URL(value);
  return url.origin === own ? `${target}${url.pathname}${url.search}${url.hash}` : value;
}

export async function proxyAccountRequest(request: Request,
  options: AccountProxyOptions): Promise<Response> {
  const incoming = new URL(request.url);
  const segments = incoming.pathname.split('/').slice(1);
  if (!isAccountServicePath(incoming.pathname) || segments.length > 8
    || !segments.every(item => segment.test(item))) {
    return Response.json({ error: 'unknown Account path' }, { status: 404,
      headers: { 'cache-control': 'no-store' } });
  }
  const own = incoming.origin;
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Better Auth answers `Sec-Fetch-Mode: cors` with JSON instead of a redirect.
  // Browsers send Sec-Fetch-Site with every request; a server caller (a product
  // BFF exchanging a code, or its authorize check) does not, but a Node fetch
  // underneath it may still add `cors` (undici does, as Wrangler's dev proxy
  // does when proxy variables are set). Mark server callers as not a browser
  // fetch so they get the redirects a server expects.
  if (request.headers.has('sec-fetch-site')) {
    for (const name of fetchMetadata) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  } else {
    headers.set('sec-fetch-mode', 'no-cors');
  }
  // A browser request from this origin is a request from the public Account
  // origin, which Better Auth checks for CSRF. Anything else keeps its origin
  // and faces the service's own checks. Where this origin is the public one
  // (every deployment and the main checkout) the rewrite is the identity.
  for (const name of ['origin', 'referer']) {
    const value = request.headers.get(name);
    if (!value) continue;
    headers.set(name, sameOrigin(value, own)
      ? name === 'origin' ? options.publicOrigin : reorigin(value, own, options.publicOrigin)
      : value);
  }
  // Only the edge knows the client address; a client-sent value is never trusted.
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  const target = new URL(`${incoming.pathname}${incoming.search}`, options.serviceOrigin);
  let upstream: Response;
  try {
    upstream = await (options.fetch ?? fetch)(target, { method: request.method, headers,
      body: bodyless.has(request.method) ? undefined : request.body, duplex: 'half',
      redirect: 'manual', cache: 'no-store' } as RequestInit);
  } catch {
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '5' } });
  }
  const outgoing = new Headers(upstream.headers);
  // fetch has already decoded the body; its original framing no longer applies.
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) {
    outgoing.delete(name);
  }
  const location = upstream.headers.get('location');
  if (location && /^https?:/i.test(location)) {
    outgoing.set('location', reorigin(location, options.publicOrigin, own));
  }
  if (!outgoing.has('cache-control')) outgoing.set('cache-control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : upstream.body,
    { status: upstream.status, statusText: upstream.statusText, headers: outgoing });
}
