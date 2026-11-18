import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { deLocalizeUrl, localizeUrl } from '../../src/paraglide/runtime.js';
import { paraglideMiddleware } from '../../src/paraglide/server.js';
import { withPageVisitHost } from '../../src/subject/page-visit-binding';

/** Install the Web visit binding in fixtures that compose their own query or route context. */
export { withPageVisitHost };

/** Render the real reader under the query and route owners used by the website. */
export async function renderSubject(content: ReactNode, href: string): Promise<string> {
  const url = new URL(href, 'https://rezics.invalid');
  const request = new Request(url);
  const response = await paraglideMiddleware(request, async () => {
    const router = createRouter({
      routeTree: createRootRoute({ component: withPageVisitHost(() => content) }),
      // Start seeds server history with the serialized request path, including encoded slugs.
      history: createMemoryHistory({ initialEntries: [`${url.pathname}${url.search}${url.hash}`] }),
      origin: url.origin,
      isServer: true,
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    await router.load();
    const html = renderToString(
      createElement(QueryClientProvider, {
        client: new QueryClient(),
        children: createElement(RouterProvider, { router }),
      }),
    );
    return new Response(html);
  });
  return response.text();
}
