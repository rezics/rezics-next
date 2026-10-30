import { validatePublicOrigin } from '../shell/origin.ts';

// Private workspaces and editor paths below a locale (docs/seo.md Indexing). Robots wildcards match any sequence,
// so shared reader families get only editor suffix rules. Public readers and noindex listings remain crawlable;
// native admission, current disclosure and page noindex remain authoritative regardless of these discovery rules.
const notCrawledRoutes = [
  '/accounts',
  '/organizations',
  '/review/account-verifications',
  '/access',
  '/settings',
  '/library',
  '/orders',
  '/entitlements',
  '/creator',
  '/my/zones',
  '/inbox',
  '/moderation',
  '/imports/review',
  '/collections/new',
  '/boards/*/new',
  '/boards/*/moderation',
  '/curate',
  '/catalogue/new',
  '/catalogue/publication',
  '/catalogue/recipe',
  '/contexts',
  '/editions/new',
  '/realms/new',
  // An unbounded /edit prefix would also suppress the public /editions subject view.
  '/subjects/*/*/edit$',
  '/subjects/*/*/edit?',
  '/subjects/*/*/edit/',
  '/subjects/*/*/relation-edit',
  '/subjects/*/*/authored',
  '/subjects/*/*/recipe',
  '/subjects/*/*/terms',
  '/subjects/*/*/statement-consent',
  '/subjects/*/*/context-review',
] as const;

// Paths outside the locale prefix: authentication pages, the API and server functions, and the checkout start.
const notCrawledPaths = ['/auth/', '/api/', '/_serverFn/', '/checkout', '/orders/'] as const;

export type RobotsOptions = { origin?: string; locales: readonly string[] };

export function robotsResponse(request: Request, { origin, locales }: RobotsOptions): Response | undefined {
  if (new URL(request.url).pathname !== '/robots.txt') return undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  let base: string;
  try {
    // Accept the existing root-slash spelling, then use the same origin contract as page heads.
    base = validatePublicOrigin(origin?.endsWith('/') ? origin.slice(0, -1) : origin);
  } catch {
    return new Response(request.method === 'HEAD' ? null : 'Robots unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'retry-after': '3600' },
    });
  }
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
