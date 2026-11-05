import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { classifyAuthRequest } from '../src/route-failure';
import { RouteFailureError } from '../src/route-failure-view';
import { Route as authRoot } from '../src/routes/__root';
import { overwriteGetLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { privateNoStore } from '../src/server';

const browser = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

test('only admitted browser documents reach the missing UI route; native, POST and asset paths stay outside it', () => {
  const classify = (path: string, method = 'GET', headers: Record<string, string> = browser) =>
    classifyAuthRequest(
      new Request(`https://auth.test${path}`, { method, headers }),
      new URL(`https://auth.test${path}`).pathname,
    );

  expect(classify('/')).toBe('ui-page');
  expect(classify('/login')).toBe('ui-page');
  expect(classify('/account/delete')).toBe('ui-page');
  expect(classify('/typo?authorization_code=private')).toBe('browser-document');
  expect(classify('/authorize?code=private')).toBe('native');
  expect(classify('/.well-known/openid-configuration')).toBe('native');
  expect(classify('/logout/confirm')).toBe('native');
  expect(classify('/token', 'POST')).toBe('native');
  expect(classify('/consent', 'POST')).toBe('upstream');
  expect(classify('/typo', 'POST')).toBe('other');
  expect(classify('/auth-assets/missing.svg')).toBe('asset');
  expect(classify('/typo', 'GET', { accept: 'application/json' })).toBe('other');
  expect(classify('/_serverFn/private-read', 'POST', { ...browser, 'sec-fetch-site': 'cross-site' })).toBe(
    'server-function',
  );
});

test('SSR missing routes retain the Auth document, localized 404 view, and no-store status', async () => {
  overwriteGetLocale(() => 'fr');
  const history = createMemoryHistory({
    initialEntries: [
      '/not-a-page?authorization_code=private-code&return_to=https%3A%2F%2Fprivate.test&email=person%40example.test',
    ],
  });
  const routeTree = authRoot.addChildren([] as never);
  const router = createRouter({
    history,
    routeTree,
    defaultErrorComponent: RouteFailureError,
    ssr: { nonce: 'safe-test-nonce' },
  });
  await router.load();
  const html = renderToString(createElement(RouterProvider, { router }));
  const response = privateNoStore(new Response(html, { status: 404, headers: { 'Content-Type': 'text/html' } }));

  expect(router.state.matches.some((match) => (match as { _notFound?: boolean })._notFound)).toBe(true);
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(html).toContain('<html lang="fr"');
  expect(html).toContain(m.auth_route_missing_title());
  expect(html).toContain('REZICS');
  expect(html).not.toContain('private-code');
  expect(html).not.toContain('private.test');
  expect(html).not.toContain('person@example.test');
  history.destroy();
});

test('cross-site server functions remain forbidden and private', async () => {
  const { default: authServer } = await import('../src/server');
  const response = await authServer.fetch(
    new Request('https://auth.test/_serverFn/private-read?token=private-token', {
      method: 'POST',
      headers: {
        origin: 'https://outside.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );

  expect(response.status).toBe(403);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.text()).toBe('');
});

test('assets do not become HTML recovery pages', async () => {
  const { default: authServer } = await import('../src/server');
  const response = await authServer.fetch(
    new Request('https://auth.test/auth-assets/missing.svg', { headers: browser }),
  );

  expect(response.status).toBe(404);
  expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  expect(await response.text()).toBe('Not Found');
});
