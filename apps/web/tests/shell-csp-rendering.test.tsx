import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as React from 'react';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => new Request('https://site.test/en') }));
mock.module('cloudflare:workers', () => ({ env: {} }));

const require = createRequire(import.meta.url);
const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
const window = new Window({ url: 'https://site.test/en', width: 390, height: 844 });
const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
window.matchMedia = ((query: string) => {
  let current = media.get(query);
  if (!current) {
    current = { matches: query === '(max-width: 767px)', listeners: new Set() };
    media.set(query, current);
  }
  return {
    media: query,
    get matches() {
      return current!.matches;
    },
    addEventListener: (_: string, listener: () => void) => current!.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => current!.listeners.delete(listener),
  } as unknown as MediaQueryList;
}) as typeof window.matchMedia;

const globalValues = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globalValues).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globalValues))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import('react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useRouter } =
  await import('@tanstack/react-router');
const session = await import('../src/session/query');
const exposure = await import('../src/kernel/exposure');
const unread = await import('../src/inbox/unread-badge');
const sessionSpy = spyOn(session, 'useSession').mockReturnValue({ state: 'signed-out', csrfToken: null });
const operationSpy = spyOn(exposure, 'useOperation').mockReturnValue(false);
const unreadSpy = spyOn(unread, 'useInboxUnreadCount').mockReturnValue({ data: undefined, isError: false } as never);
const { AppShell } = await import('../src/shell/shell');
const { securityHeaders } = await import('../src/security/headers');

function withoutWindow<T>(render: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'window');
  try {
    return render();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
  }
}

const nonce = 'c29tZS1kb2N1bWVudC1ub25jZQ==';
let failPrivateRead = true;
let retryWork: Promise<unknown> = Promise.resolve();

function RetryRead() {
  const router = useRouter();
  return (
    <button
      data-csp-retry
      type="button"
      onClick={() => {
        failPrivateRead = false;
        retryWork = router.invalidate();
      }}
    >
      Retry read
    </button>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <AppShell communities={null} search={<input aria-label="Search" />}>
      <Outlet />
    </AppShell>
  ),
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/en',
  component: () => (
    <>
      <h1>Home</h1>
      <Link to="/en/search">Open Search</Link>
    </>
  ),
});
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/en/search',
  component: () => <h1>Search results</h1>,
});
const privateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/en/private',
  loader: () => {
    if (failPrivateRead) throw new Error('Private read unavailable');
  },
  component: () => <h1>Private document ready</h1>,
  errorComponent: RetryRead,
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, searchRoute, privateRoute]),
  history: createMemoryHistory({ initialEntries: ['/en'] }),
  ssr: { nonce },
});
const app = () => (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);

afterAll(() => {
  mock.restore();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the shared shell keeps one document nonce and measured phone clearance through hydration, navigation and retry', async () => {
  await router.load();
  const markup = withoutWindow(() => renderToString(app()));
  const policy = securityHeaders(new Request('https://site.test/en'), nonce, 'https://auth.site.test').get(
    'content-security-policy',
  )!;
  expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`);
  expect(policy).toContain("style-src-attr 'unsafe-inline'");
  expect(policy).not.toContain("style-src 'self' 'unsafe-inline'");
  const styles = [...markup.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
  expect(styles).toHaveLength(3);
  for (const [, attributes] of styles) expect(attributes).toContain(`nonce="${nonce}"`);
  expect(markup).toContain('<noscript>');
  expect(markup).toContain('href="/en/settings"');
  expect(markup).toContain('href="/en"');

  const css = await Bun.file(new URL('../src/styles.css', import.meta.url)).text();
  expect(css).toContain('--bottom-nav-height: calc(5rem + env(safe-area-inset-bottom, 0px))');
  expect(css).toContain('(min-width: 768px), (display-mode: standalone)');

  const host = window.document.createElement('div');
  host.innerHTML = markup;
  window.document.body.append(host);
  const navigation = host.querySelector<HTMLElement>('[data-phone-navigation]')!;
  navigation.getBoundingClientRect = () => ({ height: 72 }) as DOMRect;
  const clearance = host.querySelector<HTMLElement>('[data-phone-navigation-clearance]')!;
  const root = hydrateRoot(host, app());
  await act(async () => Promise.resolve());
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('72px');

  const phone = media.get('(max-width: 767px)')!;
  const standalone = media.get('(display-mode: standalone)')!;
  const changeMedia = async (entry: { matches: boolean; listeners: Set<() => void> }, matches: boolean) => {
    entry.matches = matches;
    await act(async () => entry.listeners.forEach((listener) => listener()));
  };
  await changeMedia(phone, false);
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('0px');
  await changeMedia(phone, true);
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('72px');
  await changeMedia(standalone, true);
  expect(clearance.dataset.standalone).toBe('true');
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('0px');
  await changeMedia(standalone, false);
  expect(clearance.dataset.standalone).toBeUndefined();

  await act(async () => {
    await router.navigate({ to: '/en/search' });
  });
  expect(host.textContent).toContain('Search results');
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('72px');

  await act(async () => {
    await router.navigate({ to: '/en/private' });
  });
  expect(host.querySelector('[data-csp-retry]')).not.toBeNull();
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-csp-retry]')!.click();
    await retryWork;
  });
  expect(host.textContent).toContain('Private document ready');
  for (const style of host.querySelectorAll('style[nonce]')) expect(style.getAttribute('nonce')).toBe(nonce);
  expect(host.querySelectorAll('style:not([nonce])')).toHaveLength(0);

  await act(async () => root.unmount());
  expect(clearance.style.getPropertyValue('--bottom-nav-height')).toBe('');
  sessionSpy.mockRestore();
  operationSpy.mockRestore();
  unreadSpy.mockRestore();
});
