import { negotiateLocale } from '../src/i18n/locales.ts';
import { pageIds, pageSlug } from '../src/pages.ts';
import type { AboutEnv } from './env.ts';
import { handleNotify } from './notify.ts';

const unprefixed = new Set(pageIds.filter((id) => id !== 'home').map(pageSlug));

/**
 * The only dynamic behavior of the site: negotiate `/` and the unprefixed page
 * paths to a locale, and store notify signups. Everything else is a static
 * asset. Returns `undefined` for a request the assets should answer, which lets
 * the Worker and the development server share one implementation.
 */
export async function handleDynamic(
  request: Request,
  env: AboutEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/api/notify') return handleNotify(request, env);
  if (path.startsWith('/api/'))
    return Response.json(
      { type: 'about:blank', title: 'not_found', status: 404 },
      { status: 404, headers: { 'content-type': 'application/problem+json' } },
    );
  const slug = path.slice(1);
  if (
    (path === '/' || unprefixed.has(slug)) &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const locale = negotiateLocale(
      request.headers.get('cookie'),
      request.headers.get('accept-language'),
    );
    const target = new URL(path === '/' ? `/${locale}/` : `/${locale}/${slug}/`, url);
    target.search = url.search;
    return new Response(null, {
      status: 302,
      headers: {
        location: target.toString(),
        vary: 'Accept-Language, Cookie',
        'cache-control': 'private, no-store',
      },
    });
  }
  return undefined;
}
