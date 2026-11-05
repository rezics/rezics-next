import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import { MineCollectionsWindowsVisit } from '../src/library/mine-collections-windows/visit';
import type { MineCollectionsViewerPage } from '../src/library/mine-collections-route';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test'),
  setResponseHeader() {},
}));
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'mine-collections-windows',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', subject: 'viewer-A', accessToken: 'credential-A', csrfToken: 'csrf-A' }),
    }),
  },
};
mock.module('cloudflare:workers', () => ({ env }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/collections?layout=rows', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function collection(id: string) {
  return { id, title: `Collection ${id}`, curator: null, visibility: 'private' as const };
}

function response(
  cursor: string | null,
  layout: 'rows' | 'previews',
  options: { state?: 'loaded' | 'unavailable'; reset?: boolean } = {},
): MineCollectionsViewerPage {
  const first = cursor === null || cursor === 'stale';
  const collections = first ? [collection('first')] : cursor === 'cursor-a' ? [collection('sparse')] : [];
  const next = first || cursor === 'stale' ? 'cursor-a' : cursor === 'cursor-a' ? 'cursor-b' : null;
  return {
    sessionSubject: 'viewer-A',
    requested: { cursor, layout },
    page: {
      signedIn: true,
      state: options.state ?? 'loaded',
      collections: options.state === 'unavailable' ? [] : collections,
      navigationCollections: options.state === 'unavailable' ? [] : collections,
      savedQueryCapability: 'available',
      next: options.state === 'unavailable' ? null : next,
      ...(options.reset ? { cursorReset: true } : {}),
    },
    pins: { state: 'loaded', pins: [], revision: 1, next: null, canUpdate: true, canRemove: true },
  };
}

test('a route visit retains only eight admitted predecessor coordinates plus its current coordinate', () => {
  const visit = new MineCollectionsWindowsVisit();
  const authority = 'viewer-observation-A';
  visit.observe(authority, null, 'rows', 'first-entry');
  visit.accept(authority, null);
  let source: string | null = null;
  for (let index = 1; index <= 10; index++) {
    const target = `cursor-${index}`;
    expect(visit.beginMovement(authority, 'next', source, target)).toBe(true);
    visit.observe(authority, target, 'rows', `entry-${index}`);
    visit.accept(authority, target);
    source = target;
  }
  expect(visit.getSnapshot().coordinates).toEqual([
    'cursor-2',
    'cursor-3',
    'cursor-4',
    'cursor-5',
    'cursor-6',
    'cursor-7',
    'cursor-8',
    'cursor-9',
    'cursor-10',
  ]);
});

test('the private Collections route retains admitted cursor coordinates across loader and reader remounts', async () => {
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const {
    createRoute,
    createMemoryHistory,
    createRootRouteWithContext,
    createRouter,
    Outlet,
    RouterProvider,
  } = await import('@tanstack/react-router');
  const { anonymousReadMode } = await import('../src/kernel/credential');
  const { Route } = await import('../src/routes/library/collections');
  const { browserObservation } = await import('../src/session/observation');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { m } = await import('../src/paraglide/messages.js');
  const { deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
  const reads = await import('../src/library/mine-collections-route');
  const inputs: { cursor: string | null; layout: 'rows' | 'previews' }[] = [];
  let allowRetry = false;
  const reader = spyOn(reads, 'readMineCollectionsViewerPage').mockImplementation(async ({ data }) => {
    const cursor = data.cursor ?? null;
    const layout = data.layout;
    inputs.push({ cursor, layout });
    if (cursor === 'cursor-b' && !allowRetry) return response(cursor, layout, { state: 'unavailable' });
    return response(cursor, layout, { ...(cursor === 'stale' ? { reset: true } : {}) });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'viewer-A',
    csrfToken: 'csrf-A',
  });
  const observation = browserObservation(client);
  const releaseObservation = observation.subscribe(() => {});
  const observed = observation.getSnapshot();
  if (observed.state !== 'signed-in') throw new Error('Expected the prepared viewer observation');
  client.setQueryData(viewerExposureQuery(observed.observation).queryKey, {
    subject: 'viewer-A',
    admitted: ['collections', 'personal_library'],
  });

  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient; credentialMode: typeof anonymousReadMode }>()({
    component: Outlet,
  });
  const route = Route.update({ getParentRoute: () => rootRoute, path: '/library/collections' } as never);
  const collectionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/collections/$id',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, collectionRoute]),
    context: { queryClient: client, credentialMode: anonymousReadMode },
    history: createMemoryHistory({ initialEntries: ['/en/library/collections?layout=rows'] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const host = document.createElement('main');
  document.body.append(host);
  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://site.test/library/collections';
  document.head.append(canonical);
  const root = createRoot(host);
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
  const movementLink = (label: string) => {
    const nav = [...host.querySelectorAll('nav')].find(
      (candidate) => candidate.getAttribute('aria-label') === m.library_collections_heading(),
    );
    const link = [...(nav?.querySelectorAll('a') ?? [])].find((candidate) => candidate.textContent?.trim() === label);
    if (!link) throw new Error(`Missing Collections movement: ${label}`);
    return link as HTMLAnchorElement;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
  };
  const navigate = async (href: string) => {
    await act(async () => {
      await router.navigate({ href });
    });
    await flush();
  };
  try {
    await router.load();
    await act(async () => root.render(tree()));
    await flush();
    expect(host.textContent).toContain(m.library_saved_queries_empty_page());
    expect(host.textContent).not.toContain(m.library_saved_queries_unavailable());

    const next = movementLink(m.library_collection_more());
    next.focus();
    await click(next);
    expect((router.state.location.search as Record<string, unknown>).cursor).toBe('cursor-a');
    expect(host.querySelector('[data-collection-browse="rows"]')?.textContent).toContain('Collection sparse');
    expect(document.activeElement?.hasAttribute('data-collections-list-region')).toBe(true);

    const previews = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.library_collection_previews()}"]`);
    if (!previews) throw new Error('Missing preview layout control on the sparse continuation');
    await click(previews);
    expect(router.state.location.search).toEqual({ cursor: 'cursor-a', layout: 'previews' });

    await click(movementLink(m.library_collection_more()));
    expect((router.state.location.search as Record<string, unknown>).cursor).toBe('cursor-b');
    expect(host.textContent).toContain(m.library_collections_unavailable());
    const failedReads = inputs.filter((input) => input.cursor === 'cursor-b');
    expect(failedReads.length).toBeGreaterThan(0);
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_collections_retry(),
    );
    if (!retry) throw new Error('Missing retry action for the failed cursor movement');
    const retryStart = inputs.length;
    allowRetry = true;
    await click(retry);
    expect(host.textContent).toContain(m.library_collections_page_empty());
    expect(movementLink(m.library_collections_first_page()).getAttribute('href')).not.toContain('cursor=');
    expect(inputs.slice(retryStart).length).toBeGreaterThan(0);
    expect(
      inputs.slice(retryStart).every((input) => input.cursor === 'cursor-b' && input.layout === 'previews'),
    ).toBe(true);
    expect(movementLink(m.library_collections_previous()).getAttribute('href')).toContain('cursor=cursor-a');

    await click(movementLink(m.library_collections_previous()));
    expect(router.state.location.search).toEqual({ cursor: 'cursor-a', layout: 'previews' });
    await click(movementLink(m.library_collections_first_page()));
    expect(router.state.location.search).toEqual({ layout: 'previews' });

    await navigate('/en/library/collections?cursor=stale&layout=rows');
    expect(host.textContent).toContain(m.library_collections_cursor_reset());
    expect(
      [...host.querySelectorAll('nav')].some((nav) =>
        [...nav.querySelectorAll('a')].some((a) => a.textContent?.trim() === m.library_collections_previous()),
      ),
    ).toBe(false);
    await click(movementLink(m.library_collection_more()));
    expect(router.state.location.search).toEqual({ cursor: 'cursor-a', layout: 'rows' });
    expect(movementLink(m.library_collections_previous()).getAttribute('href')).not.toContain('cursor=stale');

    await navigate('/en/library/collections?cursor=direct&layout=rows');
    expect(movementLink(m.library_collections_first_page()).getAttribute('href')).toContain('layout=rows');
    expect(
      [...host.querySelectorAll('nav')].some((nav) =>
        [...nav.querySelectorAll('a')].some((a) => a.textContent?.trim() === m.library_collections_previous()),
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    releaseObservation();
    client.clear();
    host.remove();
    canonical.remove();
    reader.mockRestore();
  }
});
