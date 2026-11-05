import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import { installAuthLocaleNegotiation } from './locale-choice';
import { authUiPagePaths, classifyAuthRequest } from './route-failure';

installAuthLocaleNegotiation();

const fetchHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestClass = classifyAuthRequest(request, url.pathname);

    // Start's existing page functions keep issuer cookies on this host. In
    // particular, private reads use POST so the browser supplies a real Origin.
    if (requestClass === 'server-function') {
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

    if (requestClass === 'ui-page') {
      const response = await paraglideMiddleware(request, () => fetchHandler(request));
      return response.status >= 400 ? privateNoStore(response) : response;
    }

    if (requestClass === 'asset') return new Response('Not Found', { status: 404 });

    if (requestClass === 'browser-document')
      return privateNoStore(await paraglideMiddleware(request, () => fetchHandler(request)));

    if (import.meta.env.DEV && __AUTH_ORIGIN__) {
      const target = new URL(__AUTH_ORIGIN__);
      target.pathname = url.pathname;
      target.search = url.search;
      return fetch(new Request(target, request), { redirect: 'manual' });
    }

    // On the issuer host, fetch continues to Auth at the origin behind this route.
    if (authUiPagePaths.has(url.pathname)) return fetch(request);

    return new Response('Not Found', { status: 404 });
  },
};

export function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
