import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { MineCollectionsViewerPage } from '../src/library/mine-collections-route';
import type { MineCollectionsSearch } from '../src/library/mine-collections-address';

test('The ordinary Collections page offers one honest next step for signed-out empty preparing denied and failed reads and recovers without misrepresenting pins or losing the requested view', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/library/collections' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let signedIn = true;
  let collectionStatus = 503;
  let stale = false;
  let platformClosed = false;
  let transportFails = false;
  let failPins = false;
  const collectionReads: URL[] = [];
  const pinsReads: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer native-viewer');
      if (url.pathname === '/v1/openapi.json')
        return Response.json({ paths: { '/v1/libraryPins': { get: { operationId: 'library_pin.list' } } } });
      if (url.pathname === '/v1/libraryPins') {
        pinsReads.push(url);
        expect(url.searchParams.get('limit')).toBe('100');
        return failPins
          ? Response.json({ code: 'unavailable' }, { status: 503 })
          : Response.json({
              revision: 7,
              next: null,
              pins: [
                {
                  collectionId: 'readable',
                  target: { id: 'readable', title: 'A healthy pin', membershipKind: 'curated' },
                },
                { collectionId: 'private-target', target: null },
              ],
            });
      }
      expect(url.pathname).toBe('/v1/collections');
      collectionReads.push(url);
      expect(url.searchParams.get('curatorAccountId')).toBe('viewer');
      expect(url.searchParams.get('preview')).toBe('3');
      expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(100);
      if (transportFails) throw new TypeError('Collection transport unavailable');
      if (platformClosed) return Response.json({ code: 'platform_closed' }, { status: 403 });
      if (stale) return Response.json({ code: 'stale_cursor' }, { status: 409 });
      return Response.json(
        collectionStatus === 200
          ? { collections: [], next: null }
          : collectionStatus === 202
            ? { preparing: true }
            : { code: collectionStatus === 403 ? 'forbidden' : 'unavailable' },
        { status: collectionStatus },
      );
    }) as typeof fetch,
  });
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'collections-recovery',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credential: async () => ({ status: 'active', subject: 'viewer', accessToken: 'native-viewer' }) }),
    },
  };
  let request: Request;
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env }));
  mock.module('../src/kernel/client', () => ({ kernelClient: () => client }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { Route } = await import('../src/routes/library/collections');
  const { MineCollectionsPageView } = await import('../src/library/mine-collections-page');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { requireSignedIn } = await import('../src/session/guard');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('fr', { reload: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const expose = (admitted: string[]) => queryClient.setQueryData(exposureQuery.queryKey, admitted);
  queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'viewer', csrfToken: 'csrf' });
  queryClient.setQueryData(['exposure', 'anonymous'], []);
  expose(['collections', 'personal_library']);

  // Use the default route's loader, including its real server adapters and native result mapping.
  // The isolated leaf host also exercises the defensive signed-out result; the production guard stays installed.
  const load = Route.options.loader as (context: { deps: MineCollectionsSearch }) => Promise<MineCollectionsViewerPage>;
  const route = createRootRoute({
    loader: async ({ location }) => {
      const url = new URL(location.href, 'https://site.test');
      request = new Request(url, { headers: signedIn ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {} });
      const cursor = url.searchParams.get('cursor');
      return { ...(await load({ deps: { layout: 'previews', ...(cursor ? { cursor } : {}) } })), cursor };
    },
    component: () => {
      const { page, pins, cursor } = route.useLoaderData();
      return createElement(MineCollectionsPageView, { page, pins, layout: 'previews', ...(cursor ? { cursor } : {}) });
    },
  });
  const cursor = 'opaque+/page==&return_to=https://evil.test';
  const path = `/fr/library/collections?${new URLSearchParams({ layout: 'previews', cursor })}`;
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: [path] }) });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const occurrences = (text: string) => host.textContent!.split(text).length - 1;
  const action = (label: string) => {
    const link = [...host.querySelectorAll('a')].find((element) => element.textContent?.trim() === label);
    expect(link, `Missing real action: ${label}`).toBeDefined();
    return link!;
  };
  const refresh = () =>
    act(async () => {
      await router.invalidate();
    });
  const follow = (link: ReturnType<typeof action>) =>
    act(async () => {
      const url = new URL(link.getAttribute('href')!, 'https://site.test');
      await router.navigate({ href: url.pathname + url.search });
    });
  try {
    const oversizedCursor = 'x'.repeat(4097);
    const validateSearch = Route.options.validateSearch as
      | ((search: Record<string, unknown>) => {
          cursor?: string;
          layout: 'rows' | 'previews';
          addressError?: { cursor?: string };
        })
      | undefined;
    const rejectedAddress = validateSearch!({ cursor: oversizedCursor, layout: 'previews' });
    expect(rejectedAddress?.cursor).toBeUndefined();
    expect(rejectedAddress?.addressError?.cursor).toHaveLength(160);
    const rejected = await load({ deps: rejectedAddress! });
    expect(rejected.requested).toEqual({ ...rejectedAddress, cursor: null });
    expect(rejected.page.invalidAddress).toEqual(rejectedAddress?.addressError);
    expect(collectionReads).toHaveLength(0);
    expect(pinsReads).toHaveLength(0);

    await router.load();
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
      ),
    );
    expect(occurrences(m.library_collections_unavailable())).toBe(1);
    expect(host.querySelector('[data-library-navigation]')?.getAttribute('data-collections-state')).toBe('unavailable');
    expect(action(m.library_collections_retry()).getAttribute('href')).toBe(path);
    expect(host.querySelector('a[href="/fr/collections/readable"]')).not.toBeNull();
    expect(host.querySelector('a[href="/fr/collections/private-target"]')).toBeNull();
    expect(host.textContent).not.toContain('private-target');
    expect(host.textContent).not.toContain(m.library_collections_empty());
    expect(host.textContent).not.toContain(m.library_collection_new());
    expect(host.querySelector('[role="toolbar"]')).toBeNull();
    expect(collectionReads).toHaveLength(1);
    expect(collectionReads[0]!.searchParams.get('cursor')).toBe(cursor);

    collectionStatus = 200;
    await follow(action(m.library_collections_retry()));
    expect(host.textContent).toContain(m.library_collections_page_empty());
    expect(host.textContent).not.toContain(m.library_collections_empty());
    expect(host.textContent).not.toContain(m.library_collection_new());
    await follow(action(m.library_collections_first_page()));
    expect(host.textContent).toContain(m.library_collections_empty());
    expect(action(m.library_collection_new()).getAttribute('href')).toBe('/fr/collections/new');
    expect(occurrences(m.library_collection_new())).toBe(1);
    expect(host.textContent).not.toContain(m.library_collections_unavailable());
    expect(host.querySelector('[data-library-navigation]')?.getAttribute('data-collections-state')).toBe('loaded');

    await act(async () => {
      expose(['personal_library']);
    });
    expect(host.textContent).toContain(m.library_collections_start_unavailable());
    expect(host.textContent).not.toContain(m.library_collection_new());
    expect(action(m.library_heading()).getAttribute('href')).toBe('/fr/library');
    await act(async () => {
      expose([]);
    });
    expect(action(m.search_heading()).getAttribute('href')).toBe('/fr/search');
    collectionStatus = 403;
    await refresh();
    expect(occurrences(m.library_collections_denied())).toBe(1);
    expect(host.querySelector('[data-library-navigation]')?.getAttribute('data-collections-state')).toBe('denied');
    expect(host.textContent).not.toContain(m.library_collections_retry());
    expect(host.textContent).not.toContain(m.library_collection_new());
    action(m.search_heading());
    platformClosed = true;
    await expect(load({ deps: { layout: 'previews' } })).rejects.toMatchObject({ name: 'PlatformClosedError' });
    platformClosed = false;

    collectionStatus = 202;
    await refresh();
    expect(occurrences(m.library_collections_preparing())).toBe(1);
    expect(host.textContent).not.toContain(m.library_collections_empty());
    expect(action(m.library_collections_retry()).getAttribute('href')).toBe('/fr/library/collections?layout=previews');
    collectionStatus = 500;
    failPins = true;
    await refresh();
    expect(occurrences(m.library_collections_read_failed())).toBe(1);
    expect(occurrences(m.library_pin_read_failed())).toBe(1);
    expect(host.querySelector('[data-library-navigation]')?.getAttribute('data-collections-state')).toBe('error');
    transportFails = true;
    await refresh();
    expect(occurrences(m.library_collections_unavailable())).toBe(1);
    transportFails = false;

    // A stale cursor gets exactly one native first-page recovery, even if that recovery is also stale.
    stale = true;
    const before = collectionReads.length;
    await act(async () => {
      await router.navigate({ href: path });
    });
    expect(collectionReads.length - before).toBe(2);
    expect(collectionReads.at(-2)!.searchParams.get('cursor')).toBe(cursor);
    expect(collectionReads.at(-1)!.searchParams.has('cursor')).toBe(false);
    expect(occurrences(m.library_collections_cursor_reset())).toBe(1);
    expect(action(m.library_collections_retry()).getAttribute('href')).toBe('/fr/library/collections?layout=previews');

    const beforeRejectedAddress = collectionReads.length;
    const beforeRejectedPins = pinsReads.length;
    const invalidPath = `/fr/library/collections?layout=previews&cursor=${'x'.repeat(4097)}`;
    await act(async () => router.navigate({ href: invalidPath }));
    expect(host.querySelector('[data-collections-state="invalid-address"]')).not.toBeNull();
    expect(action(m.library_owned_collections_address_restart()).getAttribute('href')).toBe(
      '/fr/library/collections?layout=previews',
    );
    expect(collectionReads).toHaveLength(beforeRejectedAddress);
    expect(pinsReads).toHaveLength(beforeRejectedPins);

    signedIn = false;
    await act(async () => {
      queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
      await router.invalidate();
    });
    const signIn = new URL(action(m.account_sign_in()).getAttribute('href')!, 'https://site.test');
    expect(signIn.pathname).toBe('/auth/sign-in');
    expect(signIn.searchParams.get('return_to')).toBe(path);
    expect(new URL(signIn.searchParams.get('return_to')!, 'https://site.test').origin).toBe('https://site.test');
    expect(host.querySelector('[data-library-navigation]')).toBeNull();
    expect(host.querySelector('[data-library-pin-manager]')).toBeNull();
    expect(host.textContent).not.toContain(m.library_collection_new());
    expect(Route.options.beforeLoad).toBe(requireSignedIn);
    await expect(requireSignedIn({ context: { queryClient }, location: { publicHref: path } })).rejects.toMatchObject({
      options: { href: `/auth/sign-in?return_to=${encodeURIComponent(path)}` },
    });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    setLocale('en', { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
