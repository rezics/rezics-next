// Route prefixes below a locale that crawlers must not fetch (docs/seo.md Indexing): account, settings, library,
// order pages and editors. `*` stands for one dynamic segment. Every file under src/routes is either listed here or
// meant to be crawled; the sitemap test checks both directions.
const notCrawledRoutes = ['/settings', '/library', '/orders', '/collections/new', '/boards/*/new', '/curate'] as const;

// Paths outside the locale prefix: authentication pages, the API and server functions, and the checkout start.
const notCrawledPaths = ['/auth/', '/api/', '/_serverFn/', '/checkout', '/orders/'] as const;

export type RobotsOptions = { origin: string; locales: readonly string[] };

export function robotsResponse(request: Request, { origin, locales }: RobotsOptions): Response | undefined {
  if (new URL(request.url).pathname !== '/robots.txt') return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const base = (origin || new URL(request.url).origin).replace(/\/+$/, '');
  const body =
    [
      'User-agent: *',
      'Allow: /',
      ...notCrawledRoutes.map((route) => `Disallow: /*${route}`),
      ...locales.flatMap((locale) => notCrawledRoutes.map((route) => `Disallow: /${locale}${route}`)),
      ...notCrawledPaths.map((path) => `Disallow: ${path}`),
      `Sitemap: ${base}/sitemap.xml`,
    ].join('\n') + '\n';
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
