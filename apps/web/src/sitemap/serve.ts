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
    return stored(request, env.SITEMAPS, indexKey, 'application/xml; charset=utf-8', indexCache, () => unavailable());
  }
  const match = file.exec(pathname);
  if (!match) return notFound();
  return stored(
    request,
    env.SITEMAPS,
    `shards/${match[1]}-${match[2]}.xml.gz`,
    'application/gzip',
    fileCache,
    () => notFound(),
    () => unavailable(),
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
    object = await bucket.get(key, { onlyIf: request.headers });
  } catch {
    return unavailable();
  }
  if (!object) return absent();
  const headers = new Headers({ etag: object.httpEtag, 'cache-control': cacheControl });
  // A failed If-None-Match precondition returns the object without a body.
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  headers.set('content-type', contentType);
  headers.set('content-length', String(object.size));
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function unavailable(): Response {
  return new Response('Sitemap unavailable', {
    status: 503,
    headers: { 'retry-after': '3600', 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}
