// One Auth page through the real root shell in a realm without window. The parent test runs this file in a child.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';

const pages: Record<string, { url: string; module: string }> = {
  login: {
    url: '/login?response_type=code&client_id=rezics-website&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback&scope=openid&state=opaque&nonce=n&code_challenge=c&code_challenge_method=S256',
    module: '../src/routes/login.tsx',
  },
  security: { url: '/security', module: '../src/routes/security.tsx' },
  'step-up': { url: '/step-up?return_to=%2Fsecurity', module: '../src/routes/step-up.tsx' },
};
const key = process.argv[2] ?? '';
const page = pages[key];
if (!page) throw new Error(`unknown page ${key}`);
const { Route: rootRoute } = await import('../src/routes/__root.tsx');
const { Route } = await import(page.module);
const id = '/' + key;
const route = Route.update({ id, path: id, getParentRoute: () => rootRoute } as never);
const router = createRouter({
  routeTree: rootRoute.addChildren([route]),
  history: createMemoryHistory({ initialEntries: [page.url] }),
});
await router.load();
const html = renderToString(createElement(RouterProvider, { router }));
process.stdout.write(JSON.stringify({ window: typeof window, html }));
