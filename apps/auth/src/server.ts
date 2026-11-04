import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import { installAuthLocaleNegotiation } from './locale-choice';

const pagePaths = new Set([
  '/login',
  '/signup',
  '/consent',
  '/recovery',
  '/security',
  '/step-up',
  '/account/delete',
  '/account/rename',
  '/organizations/new',
  '/automated/new',
  '/automated/open',
  '/organizations/delete',
  '/organizations/members',
  '/operators/transfer',
]);
const assetPrefix = '/auth-assets/';

installAuthLocaleNegotiation();

const fetchHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Start's existing page functions keep issuer cookies on this host. In
    // particular, private reads use POST so the browser supplies a real Origin.
    if (url.pathname.startsWith('/_serverFn/')) {
      if (
        !['GET', 'POST'].includes(request.method) ||
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.method === 'POST' &&
          request.headers.get('origin') !== url.origin &&
          !(
            import.meta.env.DEV &&
            __AUTH_ORIGIN__ &&
            request.headers.get('origin') === new URL(__AUTH_ORIGIN__).origin
          ))
      )
        return new Response(null, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
      const response = await paraglideMiddleware(request, () => fetchHandler(request));
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    if (pagePaths.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return paraglideMiddleware(request, () => fetchHandler(request));
    }

    if (url.pathname.startsWith(assetPrefix)) return new Response('Not Found', { status: 404 });

    if (import.meta.env.DEV && __AUTH_ORIGIN__) {
      const target = new URL(__AUTH_ORIGIN__);
      target.pathname = url.pathname;
      target.search = url.search;
      return fetch(new Request(target, request), { redirect: 'manual' });
    }

    // On the issuer host, fetch continues to Auth at the origin behind this route.
    if (pagePaths.has(url.pathname)) return fetch(request);

    return new Response('Not Found', { status: 404 });
  },
};
