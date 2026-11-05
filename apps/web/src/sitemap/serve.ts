export type SitemapEnv = { SITEMAPS: R2Bucket };

const indexKey = 'index.xml';
const file = /^\/sitemap-([a-z]+)-([0-9a-f]{24})\.xml\.gz$/;

const indexCache = 'public, max-age=300';
const fileCache = 'public, max-age=86400, immutable';

// Serves the stored sitemap index and files, or answers undefined for any other path. One R2 `get` per request: no
// session, no cookie, no kernel request, no listing, and the body streams from the bucket.
export async function sitemapResponse(request: Request, env: Partial<SitemapEnv>): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (pathname !== '/sitemap.xml' && !pathname.startsWith('/sitemap-')) return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  if (pathname === '/sitemap.xml') {
    return stored(request, env.SITEMAPS, indexKey, 'application/xml; charset=utf-8', indexCache, () =>
      unavailable(request),
    );
  }
  const match = file.exec(pathname);
  if (!match) return notFound(request);
  return stored(
    request,
    env.SITEMAPS,
    `shards/${match[1]}-${match[2]}.xml.gz`,
    'application/gzip',
    fileCache,
    () => notFound(request),
    () => unavailable(request),
  );
}

async function stored(
  request: Request,
  bucket: R2Bucket | undefined,
  key: string,
  contentType: string,
  cacheControl: string,
  absent: () => Response,
  unbound: () => Response = absent,
): Promise<Response> {
  if (!bucket) return unbound();
  let object: R2Object | R2ObjectBody | null;
  try {
    const conditions = new Headers(request.headers);
    // HTTP gives entity tags precedence over date validators in each precondition pair.
    if (conditions.has('if-match')) conditions.delete('if-unmodified-since');
    if (conditions.has('if-none-match')) conditions.delete('if-modified-since');
    object = await bucket.get(key, { onlyIf: conditions });
  } catch {
    return unavailable(request);
  }
  if (!object) return absent();
  const headers = new Headers({ etag: object.httpEtag, 'cache-control': cacheControl });
  const status = preconditionStatus(request.headers, object);
  if (status !== undefined || !('body' in object)) {
    if ('body' in object) await object.body.cancel();
    return new Response(null, { status: status ?? 412, headers });
  }
  headers.set('content-type', contentType);
  headers.set('content-length', String(object.size));
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function preconditionStatus(headers: Headers, object: R2Object): 304 | 412 | undefined {
  const matches = (value: string, weak: boolean) =>
    value.split(',').some((tag) => {
      const candidate = tag.trim();
      return candidate === '*' || (weak ? candidate.replace(/^W\//, '') : candidate) === object.httpEtag;
    });
  const uploaded = Math.floor(object.uploaded?.valueOf() / 1_000);
  const date = (name: string) => Math.floor(Date.parse(headers.get(name) ?? '') / 1_000);
  const match = headers.get('if-match');
  if (match !== null ? !matches(match, false) : uploaded > date('if-unmodified-since')) return 412;
  const none = headers.get('if-none-match');
  if (none !== null ? matches(none, true) : uploaded <= date('if-modified-since')) return 304;
  return undefined;
}

function unavailable(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : 'Sitemap unavailable', {
    status: 503,
    headers: { 'retry-after': '3600', 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}

function notFound(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : 'Not Found', {
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}
