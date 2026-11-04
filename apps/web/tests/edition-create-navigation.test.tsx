import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/ja/editions/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  scrollTo() {},
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { creatorId, identity, publicationFixture } =
  await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} = await import('@tanstack/react-router');
const { EditionCreateRoute } = await import('../src/routes/editions/new');
const { CreatorEditionsOriginView } = await import('../src/content-editions/creator-editions-view');
const { CreatorOfferOriginAddressPanel, CreatorOfferOriginScope } = await import('../src/checkout/creator-offer-editor');
const { editionCreateSearch, editionCreateNavigationContext, editionCreateHref } =
  await import('../src/content-editions/edition-create');
const { creatorEditionSearch } = await import('../src/checkout/creator-offer-address');
const { creatorEditionsRouteSearch } = await import('../src/content-editions/creator-editions');
const { createCreatorEditionOrigin } = await import('../src/content-editions/creator-edition-origin');
const { m } = await import('../src/paraglide/messages.js');
const { deLocalizeUrl, getLocale, localizeUrl, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
setLocale('ja', { reload: false });

afterAll(async () => {
  mock.restore();
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function localizedEntry(path: string) {
  const url = localizeUrl(new URL(path, 'https://site.test'));
  return url.pathname + url.search;
}

function controls() {
  const button = (label: string) => {
    const result = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    expect(result).toBeDefined();
    return result!;
  };
  return {
    button,
    click: async (label: string) => act(async () => button(label).click()),
  };
}

test('Stay preserves the uncertain publication intent; Discard returns to the original localized inventory address', async () => {
  const fixture = await publicationFixture('uncertain');
  const originalIntent = fixture.controller.snapshot().intent;
  expect(originalIntent).not.toBeNull();
  const token = createCreatorEditionOrigin({ accountId: creatorId, cursor: 'continued/+=', editionId: null })!;
  const params = new URLSearchParams({ ...identity, editionOrigin: token });
  const entry = localizedEntry(`/editions/new?${params}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: creatorId, csrfToken: 'csrf' });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const createEditionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/editions/new',
    validateSearch: editionCreateSearch,
    loader: () => undefined,
    component: () => <EditionCreateRoute api={fixture.api} controller={fixture.controller} />,
  });
  const inventoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/editions/',
    validateSearch: creatorEditionsRouteSearch,
    component: function InventoryRoute() {
      const search = creatorEditionsRouteSearch(useLocation({ select: (location) => location.search }));
      return (
        <CreatorEditionsOriginView
          page={{ kind: 'ready', editions: [], next: null }}
          {...(search.cursor ? { cursor: search.cursor } : {})}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([createEditionRoute, inventoryRoute]),
    history: createMemoryHistory({ initialEntries: [entry] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const navigate = spyOn(router, 'navigate');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    const { button, click } = controls();
    await click(m.creator_edition_origin_return());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(m.edition_publication_leave_pending());
    await click(m.thread_authoring_stay());
    expect(fixture.controller.snapshot().intent).toBe(originalIntent);
    expect(fixture.calls.filter((call) => call.path === '/v1/contentEditions' && call.method === 'POST')).toHaveLength(1);
    expect(router.state.location.pathname).toBe('/editions/new');

    await click(m.creator_edition_origin_return());
    await click(m.thread_authoring_leave());
    await act(async () => navigate.mock.results.at(-1)?.value);
    expect(router.state.location.pathname).toBe('/editions/');
    expect(router.state.location.search).toMatchObject({ cursor: 'continued/+=', editionOrigin: token });
    expect(router.state.location.search).not.toHaveProperty('postId');
    expect(router.state.location.search).not.toHaveProperty('revisionId');
    expect(host.textContent).toContain(m.creator_edition_origin_available());
    const returnUrl = new URL(router.history.location.href, 'https://site.test');
    expect(returnUrl.pathname).toBe('/ja/editions');
    expect(returnUrl.searchParams.get('cursor')).toBe('continued/+=');
    expect(returnUrl.searchParams.get('editionOrigin')).toBe(token);
    expect(returnUrl.searchParams.has('postId')).toBe(false);
    expect(returnUrl.searchParams.has('revisionId')).toBe(false);
    expect(fixture.calls.filter((call) => call.path === '/v1/contentEditions' && call.method === 'POST')).toHaveLength(1);
    expect(button(m.creator_edition_origin_restart())).toBeDefined();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    navigate.mockRestore();
  }
});

test('published Edition hands off its exact current identity and locale without adding origin to the public link', async () => {
  const fixture = await publicationFixture('published');
  const edition = fixture.controller.snapshot().edition!;
  const token = createCreatorEditionOrigin({
    accountId: edition.creatorAccountId,
    cursor: 'inventory/opaque',
    editionId: edition.editionId,
  })!;
  const entry = localizedEntry(
    `/editions/new?${new URLSearchParams({ editionId: edition.editionId, editionOrigin: token })}`,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: edition.creatorAccountId, csrfToken: 'csrf' });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const createEditionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/editions/new',
    validateSearch: editionCreateSearch,
    loader: () => undefined,
    component: () => <EditionCreateRoute api={fixture.api} controller={fixture.controller} />,
  });
  const offerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/offers/new',
    validateSearch: creatorEditionSearch,
    component: function OfferRoute() {
      const search = creatorEditionSearch(useLocation({ select: (location) => location.search }));
      return (
        <CreatorOfferOriginScope token={search.editionOrigin} editionId={search.contentEditionId}>
          <CreatorOfferOriginAddressPanel />
        </CreatorOfferOriginScope>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([createEditionRoute, offerRoute]),
    history: createMemoryHistory({ initialEntries: [entry] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const navigate = spyOn(router, 'navigate');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    const offer = [...host.querySelectorAll('a')].find((link) => link.textContent === m.edition_publication_create_offer());
    expect(offer?.getAttribute('href')).toBe(`/ja/creator/offers/new?editionId=${edition.editionId}`);
    expect(offer?.getAttribute('href')).not.toContain('editionOrigin');
    await act(async () => offer!.click());
    await act(async () => navigate.mock.results.at(-1)?.value);
    expect(router.state.location.pathname).toBe('/creator/offers/new');
    expect(router.state.location.search).toMatchObject({ contentEditionId: edition.editionId, editionOrigin: token });
    expect(host.textContent).toContain(m.creator_edition_origin_edition());
    expect(host.textContent).toContain(edition.editionId);
    const handoffUrl = new URL(router.history.location.href, 'https://site.test');
    expect(handoffUrl.pathname).toBe('/ja/creator/offers/new');
    expect(handoffUrl.searchParams.get('editionId')).toBe(edition.editionId);
    expect(handoffUrl.searchParams.get('editionOrigin')).toBe(token);
    expect(handoffUrl.searchParams.has('cursor')).toBe(false);
    expect(handoffUrl.searchParams.has('postId')).toBe(false);
    expect(handoffUrl.searchParams.has('revisionId')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    navigate.mockRestore();
  }
});

test('the origin marker is navigation context only and never changes canonical or native operands', () => {
  const token = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
  const sourceAddress = editionCreateHref(identity, 'ja');
  const search = editionCreateSearch({ ...identity, editionOrigin: token });
  expect(search).toEqual({ ...identity, editionId: undefined, editionOrigin: token });
  expect(editionCreateNavigationContext({ pathname: '/ja/editions/new', search })).toContain(`origin:${token}`);
  expect(sourceAddress).toBe(`/ja/editions/new?postId=${identity.postId}&revisionId=${identity.revisionId}`);
  expect(sourceAddress).not.toContain('editionOrigin');
});
