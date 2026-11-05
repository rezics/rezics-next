import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import { producerRecoveryExample } from '../src/features/pages/producer-history-reading/examples';
import { producerStudioId } from '../src/kernel/fake/producer-history';
import { organizationHistoryVisitReturnFragment } from '../src/features/pages/subject-visit-navigation';
import { candidateContext } from '../src/subject/candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const admitted = producerRecoveryExample().first;
const producerReads: { data: Record<string, unknown> }[] = [];
mock.module('../src/features/catalogue/producer-history/actions', () => ({
  readSubjectProducerHistory: async (input: { data: Record<string, unknown> }) => {
    producerReads.push(input);
    return admitted;
  },
}));

const locale = 'en';
const globalContext = candidateContext;
const unsupportedContext = '00000000-0000-4000-8000-00000000d812';
const realm = '00000000-0000-4000-8000-00000000d813';
const selected = '00000000-0000-4000-8000-00000000d814';

function historyFragment(context: string) {
  return organizationHistoryVisitReturnFragment({
    holder: producerStudioId,
    context,
    locale,
    property: 'wdt:P749',
    candidate: selected,
    revision: 7,
    release: 'organization-release',
    focus: 'keyboard',
  });
}

test('public Organization entry preserves Context and current return, refuses unsupported visits, and names fresh Global', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/${locale}/subjects/${producerStudioId}/paper-lantern-studio` });
  window.scrollTo = () => undefined;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { ProducerHistoryEntry } = await import('../src/features/catalogue/producer-history/entry');
  const { Route: ProducerRoute } = await import('../src/routes/subjects/$id_.$slug.producer');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { browserObservation } = await import('../src/session/observation');
  const { producerHistoryEntryVisit, producerHistoryVisitReturn } =
    await import('../src/features/catalogue/producer-history/visit');
  const messages = await import('../src/paraglide/messages.js');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(['session'], { state: 'signed-in', subject: 'origin-reader', csrfToken: 'csrf-origin' });
  const stopObservation = browserObservation(queryClient).subscribeCache(() => {});

  const rootRoute = createRootRouteWithContext<{ queryClient: typeof queryClient }>()({ component: Outlet });
  const localeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$locale', component: Outlet });
  const OriginRoute = createRoute({
    getParentRoute: () => localeRoute,
    path: `/subjects/$id/$slug`,
    validateSearch: (search: Record<string, unknown>) => {
      if (typeof search.context !== 'string') throw new Error('Expected the public reading Context');
      return { context: search.context };
    },
    component: PublicOrigin,
  });
  function PublicOrigin() {
    const { context } = OriginRoute.useSearch();
    const currentHref = `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${context}${historyFragment(context)}`;
    return h(ProducerHistoryEntry, {
      id: producerStudioId,
      label: 'Paper Lantern Studio',
      locale,
      context,
      currentHref,
    });
  }

  ProducerRoute.update({
    id: '/subjects/$id/$slug/producer',
    path: '/subjects/$id/$slug/producer',
    getParentRoute: () => localeRoute,
    head: () => ({}),
  } as never);
  const history = createMemoryHistory({
    initialEntries: [`/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([localeRoute.addChildren([OriginRoute, ProducerRoute])]),
    context: { queryClient },
    history,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const previousLocale = (await import('../src/paraglide/runtime.js')).getLocale();
  setLocale(locale, { reload: false });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const link = (name: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === name)!;
  const navigate = async (href: string) =>
    act(async () => {
      await router.navigate({ href });
      await tick();
    });

  try {
    await act(async () => {
      await router.load();
      root.render(h(QueryClientProvider, { client: queryClient }, h(RouterProvider, { router })));
      await tick();
    });

    const publicEntry = link(messages.m.producer_history_title());
    expect(publicEntry).toBeDefined();
    const admittedHref = new URL(publicEntry.getAttribute('href')!, 'https://site.test');
    expect(admittedHref.searchParams.get('context')).toBe(globalContext);
    const admittedReturn = admittedHref.searchParams.get('via')!;
    expect(admittedReturn).toBe(
      `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}${historyFragment(globalContext)}`,
    );

    await navigate(`${admittedHref.pathname}${admittedHref.search}`);
    await act(async () => tick());
    expect(router.state.location.pathname).toBe(admittedHref.pathname);
    expect(host.textContent).toContain(messages.m.producer_history_intro());
    expect(producerReads.length).toBe(1);
    expect(producerReads[0]!.data.id).toBe(producerStudioId);
    expect(producerReads[0]!.data.context).toBeUndefined();
    const pageReturn = link(messages.m.producer_history_back());
    expect(pageReturn.getAttribute('href')).toBe(admittedReturn);

    await navigate(`/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}`);
    const unsupportedEntry = link(messages.m.producer_history_title());
    const unsupportedHref = new URL(unsupportedEntry.getAttribute('href')!, 'https://site.test');
    expect(unsupportedHref.searchParams.get('context')).toBe(unsupportedContext);
    const unsupportedReturn = unsupportedHref.searchParams.get('via')!;
    await navigate(`${unsupportedHref.pathname}${unsupportedHref.search}`);
    expect(host.textContent).toContain(messages.m.producer_history_context_unavailable());
    expect(producerReads.length).toBe(1);
    const refusalReturn = link(messages.m.producer_history_back());
    expect(refusalReturn.getAttribute('href')).toBe(unsupportedReturn);
    const globalVisit = link(messages.m.producer_history_global_visit());
    const globalHref = new URL(globalVisit.getAttribute('href')!, 'https://site.test');
    expect(globalHref.searchParams.has('context')).toBe(false);
    expect(globalHref.searchParams.has('realm')).toBe(false);
    expect(globalHref.searchParams.get('via')).toBe(unsupportedReturn);

    await navigate(`${globalHref.pathname}${globalHref.search}`);
    await act(async () => tick());
    expect(router.state.location.search.context).toBeUndefined();
    expect(producerReads.length).toBe(2);
    expect(producerReads[1]!.data.context).toBeUndefined();
    expect(host.textContent).toContain(messages.m.producer_history_title());

    await navigate(`/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer`);
    await act(async () => tick());
    expect(router.state.location.search).toEqual({});
    expect(producerReads.length).toBe(3);

    const realmReturn = `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${globalContext}&realm=${realm}#connections`;
    await navigate(
      `/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer?context=${globalContext}&realm=${realm}&via=${encodeURIComponent(realmReturn)}`,
    );
    expect(host.textContent).toContain(messages.m.producer_history_context_unavailable());
    expect(producerReads.length).toBe(3);
    const realmGlobal = new URL(
      link(messages.m.producer_history_global_visit()).getAttribute('href')!,
      'https://site.test',
    );
    expect(realmGlobal.searchParams.has('context')).toBe(false);
    expect(realmGlobal.searchParams.has('realm')).toBe(false);
    expect(realmGlobal.searchParams.get('via')).toBe(realmReturn);
    await navigate(`${realmGlobal.pathname}${realmGlobal.search}`);
    await act(async () => tick());
    expect(producerReads.length).toBe(4);

    const oversized = producerHistoryEntryVisit({
      href: `/${locale}/subjects/${producerStudioId}/paper-lantern-studio/producer?context=${unsupportedContext}`,
      currentHref: `/${locale}/subjects/${producerStudioId}/${'history-'.repeat(250)}?context=${unsupportedContext}${historyFragment(unsupportedContext)}`,
      fallbackHref: `/${locale}/subjects/${producerStudioId}/organization`,
      id: producerStudioId,
      locale,
      context: unsupportedContext,
    });
    expect(oversized?.restarted).toBe(true);
    expect(oversized?.returnHref).toContain('#connections');
    expect(oversized?.returnHref).not.toContain('#organization-history');

    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: '00000000-0000-4000-8000-00000000d899',
        locale,
        context: unsupportedContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: producerStudioId,
        locale: 'ja',
        context: unsupportedContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(unsupportedReturn, {
        id: producerStudioId,
        locale,
        context: globalContext,
      }),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(
        `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}&realm=${realm}#connections`,
        { id: producerStudioId, locale, context: unsupportedContext, realm: '00000000-0000-4000-8000-00000000d899' },
      ),
    ).toBeUndefined();
    expect(
      producerHistoryVisitReturn(
        `/${locale}/subjects/${producerStudioId}/paper-lantern-studio?context=${unsupportedContext}&context=${unsupportedContext}#connections`,
        { id: producerStudioId, locale, context: unsupportedContext },
      ),
    ).toBeUndefined();
    const overBudget = `${unsupportedReturn}${'x'.repeat(2049)}`;
    expect(
      producerHistoryVisitReturn(overBudget, { id: producerStudioId, locale, context: unsupportedContext }),
    ).toBeUndefined();
    const validate = (ProducerRoute.options as { validateSearch?: (search: Record<string, unknown>) => unknown })
      .validateSearch!;
    expect(() => validate({ context: globalContext, extra: 'closed' })).toThrow();
    expect(() => validate({ context: globalContext, via: ['first', 'second'] })).toThrow();
    expect(() => validate({ via: 'x'.repeat(2049) })).toThrow();
  } finally {
    await act(async () => root.unmount());
    stopObservation();
    queryClient.clear();
    await window.happyDOM.abort();
    setLocale(previousLocale, { reload: false });
    for (const [key, value] of saved)
      value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    producerReads.length = 0;
  }
});
