import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { RouteLoading, pendingLayout } from '../src/shell/pending';
import { RouteState } from '../src/shell/route-state';
import { ClosedErrorPage } from '../src/shell/closed';
import { routeFailure, routeRetry, errorPageHead } from '../src/shell/error-state';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { sessionQueryKey } from '../src/session/browser-state';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const privateText = 'PRIVATE SQL https://private.example/request';
const failure = { status: 503, message: privateText, cause: { payload: privateText } };

test('safe route metadata selects bounded, localized and reduced-motion skeletons without loader data', () => {
  const locale = getLocale();
  try {
    for (const language of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      setLocale(language, { reload: false });
      expect(pendingLayout([{ routeId: '/search' }])).toBe('feed');
      expect(pendingLayout([{ routeId: '/subjects/$id' }])).toBe('detail');
      expect(pendingLayout([{ routeId: '/collections/new' }])).toBe('form');
      expect(pendingLayout([{ routeId: '/unrelated-candidate-looking-path' }])).toBe('page');
      expect(pendingLayout([{ routeId: '/unknown', ...{ staticData: { routeState: privateText } } }])).toBe('page');
      for (const layout of ['page', 'feed', 'detail', 'form'] as const) {
        const html = renderToStaticMarkup(<RouteLoading layout={layout} />);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain('motion-reduce:animate-none');
        expect(html.match(/data-skeleton-block/g)!.length).toBeLessThanOrEqual(12);
        expect(html).not.toContain('<main');
        expect(html).not.toContain(privateText);
      }
      for (const kind of ['missing', 'closed', 'error'] as const) {
        const html = renderToStaticMarkup(<RouteState kind={kind} />);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html).toContain(`href="/${language}"`);
        expect(html).toContain(`href="/${language}/search"`);
        expect(html).toContain('min-h-11');
        expect(html).not.toContain('<button');
      }
    }
  } finally { setLocale(locale, { reload: false }); }
});

test('recovery uses only native metadata, preserves noindex and bounds Retry-After without inventing status', () => {
  const now = Date.UTC(2026, 0, 1);
  expect(routeFailure([{ status: 'error', error: new Error('404 503 ' + privateText) }])?.status).toBe(500);
  expect(routeRetry({ ...failure, problem: { retryable: false } }).allowed).toBe(false);
  expect(routeRetry(new PlatformClosedError(403, {})).allowed).toBe(false);
  for (const value of ['1', '300', new Date(now + 7_000).toUTCString()]) {
    const policy = routeRetry({ headers: { 'retry-after': value } }, now);
    expect(policy.delay).toBeGreaterThan(0);
    expect(policy.delay).toBeLessThanOrEqual(300);
    expect(policy.deferred).toBe(false);
  }
  expect(routeRetry({ headers: { 'retry-after': '301' } }, now)).toEqual({ allowed: true, delay: 0, deferred: true });
  for (const after of [privateText, '-1', 'NaN', '9'.repeat(100)]) {
    expect(routeRetry({ headers: { 'retry-after': after } }, now)).toEqual({ allowed: true, delay: 0, deferred: false });
  }
  const head = errorPageHead({ origin: 'https://public.example', locale: 'en', path: '/failed', paths: { en: '/private' } });
  expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex' });
  expect(head.scripts).toEqual([]);
  expect(JSON.stringify(head)).not.toContain('private');
});

test('original loaders recover once per explicit retry, retire old visits/readers, and keep bounded state for 1/10/100 fixtures', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en' });
  const globals = { window, ...Object.fromEntries(['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node',
    'Document', 'DocumentFragment', 'MutationObserver', 'ResizeObserver'].map((key) => [key, Reflect.get(window, key)])),
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) => act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 25)); });
  let dispose = () => {};
  const counts: number[] = [];
  try {
    for (const size of [1, 10, 100]) {
      let reads = 0;
      let resolve!: (value: string) => void;
      let reject!: (error: unknown) => void;
      let hold = false;
      const items = Array.from({ length: size }, () => privateText);
      const client = new QueryClient();
      client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-a', csrfToken: 'token-a' });
      const base = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: () => <>
        <nav aria-label="Shell"><button onClick={() => void router.navigate({ to: '/search' })}>Leave</button></nav>
        <main id="main-content" tabIndex={-1}><Outlet /></main>
      </> });
      const page = createRoute({ getParentRoute: () => base, path: '/offers/$id',
        loader: async () => {
          reads++;
          if (!hold) throw { ...failure, payload: items };
          return await new Promise<string>((yes, no) => { resolve = yes; reject = no; });
        }, component: () => <h1>Current content</h1> });
      const away = createRoute({ getParentRoute: () => base, path: '/search', component: () => <h1>Search destination</h1> });
      const router = createRouter({ routeTree: base.addChildren([page, away]), context: { queryClient: client },
        history: createMemoryHistory({ initialEntries: ['/offers/prepared'] }), defaultErrorComponent: ClosedErrorPage,
        defaultPendingComponent: () => <RouteLoading layout="detail" />, defaultPendingMs: 0, defaultPendingMinMs: 0 });
      dispose = () => { router.history.destroy(); client.clear(); };
      await router.load();
      await settle(() => root.render(<RouterProvider router={router} />));
      const main = host.querySelector('main')!;
      const nav = host.querySelector('nav')!;
      const retry = () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes(m.status_retry()))!;
      expect(main.textContent).toContain(m.error_heading());
      expect(main.textContent).not.toContain(privateText);
      expect(reads).toBe(1);
      counts.push(main.querySelectorAll('*').length);
      hold = true;
      await settle(() => { retry().click(); retry().click(); });
      expect(reads).toBe(2);
      await settle(() => reject(failure));
      expect(main.textContent).toContain(m.route_retry_failed());
      expect(main.textContent).not.toContain(privateText);
      expect(host.querySelector('main')).toBe(main);
      expect(host.querySelector('nav')).toBe(nav);
      await settle(() => { retry().click(); retry().click(); });
      expect(reads).toBe(3);
      await settle(() => resolve('safe current response'));
      expect(main.textContent).toContain('Current content');
      expect(main.querySelectorAll('h1')).toHaveLength(1);
      // A pending direct visit may leave without an old completion restoring its private content.
      await settle(() => void router.navigate({ to: '/search' }));
      let pendingVisit!: Promise<void>;
      await settle(() => { pendingVisit = router.navigate({ to: '/offers/$id', params: { id: 'next' } }); });
      expect(main.querySelectorAll('[data-skeleton-block]').length).toBeLessThanOrEqual(12);
      expect(main.textContent).toContain(m.route_loading_detail());
      await settle(() => {
        client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-b', csrfToken: 'token-b' });
        void router.navigate({ to: '/search' });
      });
      await settle(() => resolve(privateText));
      await pendingVisit;
      expect(main.textContent).toBe('Search destination');
      expect(main.textContent).not.toContain(privateText);
      await settle(() => root.render(null));
      dispose();
    }
    expect(new Set(counts).size).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dispose();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 30_000);
