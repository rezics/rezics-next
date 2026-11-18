import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { withPageVisitHost } from '../../src/subject/page-visit-binding';

/** Install the Web visit binding in fixtures that compose their own query or route context. */
export { withPageVisitHost };

/** Render the real reader under the query and route owners used by the website. */
export async function renderSubject(content: ReactNode, href: string): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: withPageVisitHost(() => content) }),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  await router.load();
  return renderToString(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(RouterProvider, { router }),
    }),
  );
}
