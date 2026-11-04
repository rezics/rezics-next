import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  FormData: window.FormData,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createMemoryHistory, createRouter, Outlet, RouterProvider, useRouterState } =
  await import('@tanstack/react-router');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { LibraryPresentationBoundary } = await import('../src/library/shelf-preferences-current');
const { DisplayControls } = await import('../src/library/entries-current');
const { ShelfTypes } = await import('../src/library/shelf-types');
const { shelfHref } = await import('../src/library/shelf-params');
const { browserObservation } = await import('../src/session/observation');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { SHELF_TYPES_LIMIT } = await import('../src/library/shelf-types-read');
import type { ShelfPreferenceSnapshot } from '../src/settings/shelf-preferences-current';
import type { ShelfPreferences } from '../src/settings/preferences';
type BoundaryData = ComponentProps<typeof LibraryPresentationBoundary>['data'];
type Snapshot = ShelfPreferenceSnapshot;
const dataContext = createContext<BoundaryData | null>(null);
setLocale('en', { reload: false });

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const accountId = 'reader-current';
const csrfToken = 'reader-token-a';
const book = 'https://schema.org/Book';
const creativeWork = 'https://schema.org/CreativeWork';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-000000000901';
const saved = {
  layouts: { all: 'list' as const, [book]: 'table' as const },
  sorts: { planned: { field: 'rating' as const, direction: 'asc' as const } },
  gridSize: 'large' as const,
  tableColumns: ['title', 'progress', 'creator', 'rating'] as const,
};
function snapshot(generation: string, shelf: ShelfPreferences = saved): Snapshot {
  return { generation, accountId, csrfToken, shelf } as Snapshot;
}
function personalData(value = snapshot('visit-1')): BoundaryData {
  return {
    sessionSubject: accountId,
    requested: { type: book, state: 'planned', cursor: null, orderBy: 'createdAt', direction: 'desc', locale: 'en' },
    page: { signedIn: true, entries: [], next: null, sort: { orderBy: 'createdAt', direction: 'desc' } },
    continueEntries: { state: 'loaded', entries: [], next: null },
    navigation: { pins: { state: 'closed' }, collections: [], collectionsState: 'closed' },
    shelfSnapshot: value,
  } as BoundaryData;
}
function ordinaryTypeHref(intent: ComponentProps<typeof ShelfTypes>['view']): string {
  const view = { ...intent, type: intent.type === book ? creativeWork : book };
  delete view.cursor;
  return shelfHref('en', view);
}
function routeDataContext() {
  const Root = createRootRoute({ component: Outlet });
  function RoutePage() {
    const data = useContext(dataContext);
    const search = useRouterState({ select: (state) => state.location.search }) as Record<string, unknown>;
    if (!data) throw new Error('Missing Library fixture');
    return (
      <LibraryPresentationBoundary
        data={data}
        rawSearch={search}
        locale="en"
        readLabel={async () => {
          throw new Error('The closed label fixture has no current read.');
        }}
        renderCurrent={({ presentation }) => (
          <main
            data-testid="current-view"
            data-layout={presentation.display.layout}
            data-layout-source={presentation.display.layoutSource}
            data-size={presentation.display.size}
            data-columns={presentation.display.columns}
            data-sort={`${presentation.sort.orderBy}:${presentation.sort.direction}`}
            data-sort-source={presentation.sources.sort}
            data-cursor={presentation.search.cursor ?? ''}
          >
            <DisplayControls
              locale="en"
              type={presentation.intent.type}
              state={presentation.intent.state}
              display={presentation.display}
              presentation={presentation}
              tableAvailable={false}
            />
            <ShelfTypes
              locale="en"
              view={presentation.intent}
              typeLabel={presentation.intent.type === book ? 'Book' : 'Creative work'}
            />
            <a
              data-testid="ordinary-type-link"
              href={ordinaryTypeHref(presentation.intent)}
            >
              Ordinary type link
            </a>
          </main>
        )}
      />
    );
  }
  const route = createRoute({
    getParentRoute: () => Root,
    path: '/library',
    validateSearch: (search) => search as Record<string, unknown>,
    component: RoutePage,
  });
  return Root.addChildren([route]);
}

async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountVisit(
  data: BoundaryData,
  search = '',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  beforeMount?: (client: InstanceType<typeof QueryClient>) => void,
) {
  if (!client.getQueryData(sessionQuery.queryKey))
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken });
  beforeMount?.(client);
  const routeTree = routeDataContext();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/library${search ? `?${search}` : ''}`] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: BoundaryData) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <dataContext.Provider value={next}>
            <RouterProvider router={router} />
          </dataContext.Provider>
        </QueryClientProvider>,
      ),
    );
    await tick();
  };
  await render(data);
  return {
    client,
    host,
    root,
    router,
    render,
    close: async (clear = true) => {
      await act(async () => root.unmount());
      if (clear) client.clear();
      host.remove();
    },
  };
}

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
}
function current(host: HTMLElement) {
  return host.querySelector<HTMLElement>('[data-testid="current-view"]');
}
function searchParams(href: string) {
  return Object.fromEntries(new URL(href, 'https://site.test').searchParams.entries());
}

test('mounted Library boundary resolves saved scopes, carries deliberate URL choices, and restores only display defaults', async () => {
  const reads = await import('../src/library/shelf-types-read');
  const readTypes = spyOn(reads, 'readShelfTypesCurrent').mockResolvedValue({
    sessionSubject: accountId,
    authorizationAgrees: true,
    requested: { cursor: null, limit: SHELF_TYPES_LIMIT, locale: 'en' },
    page: { state: 'loaded', types: [{ type: creativeWork, label: 'Creative work' }], next: null },
  });
  const query = new URLSearchParams({ type: book, state: 'planned', cursor: 'stale-after-score-change' }).toString();
  let cacheSubscriptions = 0;
  const visit = await mountVisit(personalData(), query, undefined, (client) => {
    const cache = client.getQueryCache();
    const original = cache.subscribe.bind(cache);
    spyOn(cache, 'subscribe').mockImplementation((listener) => {
      cacheSubscriptions += 1;
      return original(listener);
    });
  });
  try {
    const live = current(visit.host)!;
    expect(live.dataset.layout).toBe('table');
    expect(live.dataset.layoutSource).toBe('type');
    expect(live.dataset.size).toBe('l');
    expect(live.dataset.columns).toBe('title,progress');
    expect(live.dataset.sort).toBe('personalScore:asc');
    expect(live.dataset.cursor).toBe('');
    expect(visit.host.textContent).toContain(m.library_shelf_address_stale_title());
    expect(visit.host.textContent).toContain(m.library_saved_sort_unsupported({ field: 'rating' }));
    expect(visit.host.textContent).toContain(m.library_saved_columns_unsupported());
    expect(visit.host.textContent).toContain(m.library_columns_source_saved());
    expect(cacheSubscriptions).toBe(1);

    const observation = browserObservation(visit.client).getSnapshot();
    expect(observation.state).toBe('signed-in');
    if (observation.state !== 'signed-in') throw new Error('Library observation did not admit the reader');
    visit.client.setQueryData(viewerExposureQuery(observation.observation).queryKey, {
      subject: accountId,
      admitted: ['library_shelf.types'],
    });
    await tick();
    expect(cacheSubscriptions).toBe(1);

    const typeAction = button(visit.host, m.library_type_action({ type: 'Book' }));
    expect(typeAction).toBeDefined();
    await act(async () => typeAction!.click());
    await tick();
    expect(readTypes).toHaveBeenCalledTimes(1);
    const destination = [...visit.host.querySelectorAll('a')].find((node) => node.textContent?.trim() === 'Creative work');
    expect(destination).toBeDefined();
    const firstDestination = searchParams(destination!.href);
    expect(firstDestination).toEqual({ type: creativeWork, state: 'planned' });
    await act(async () => visit.router.navigate({ to: '/library', search: firstDestination as never }));
    await tick();
    expect(current(visit.host)?.dataset.layout).toBe('list');
    expect(current(visit.host)?.dataset.layoutSource).toBe('all');

    const noAllDefault = snapshot('visit-2', {
      layouts: { [book]: 'table' },
      sorts: { planned: { field: 'rating', direction: 'asc' } },
      gridSize: 'large',
      tableColumns: ['title', 'progress', 'creator', 'rating'],
    });
    await visit.render(personalData(noAllDefault));
    expect(current(visit.host)?.dataset.layout).toBe('grid');
    expect(current(visit.host)?.dataset.layoutSource).toBe('application');
    expect(cacheSubscriptions).toBe(1);

    const explicit = {
      type: creativeWork,
      state: 'planned',
      layout: 'list',
      size: 's',
      columns: 'title,status',
      orderBy: 'finishedAt',
      direction: 'asc',
      cursor: 'native-cursor',
    };
    await act(async () => visit.router.navigate({ to: '/library', search: explicit as never }));
    await tick();
    expect(current(visit.host)).toMatchObject({
      dataset: {
        layout: 'list',
        layoutSource: 'url',
        size: 's',
        columns: 'title,status',
        sort: 'finishedAt:asc',
        sortSource: 'url',
        cursor: 'native-cursor',
      },
    });
    await act(async () => button(visit.host, m.library_layout_grid())!.click());
    await tick();
    expect(visit.router.state.location.search).toMatchObject({
      type: creativeWork,
      state: 'planned',
      layout: 'grid',
      size: 's',
      columns: 'title,status',
      orderBy: 'finishedAt',
      direction: 'asc',
    });
    expect(visit.router.state.location.search).toHaveProperty('cursor', 'native-cursor');

    const ordinaryType = [...visit.host.querySelectorAll('a')].find((node) => node.dataset.testid === 'ordinary-type-link')!;
    expect(searchParams(ordinaryType.href)).toEqual({
      type: book,
      state: 'planned',
      orderBy: 'finishedAt',
      direction: 'asc',
      layout: 'grid',
      size: 's',
      columns: 'title,status',
    });
    await act(async () => visit.router.navigate({ to: '/library', search: searchParams(ordinaryType.href) as never }));
    await tick();
    expect(current(visit.host)?.dataset.layout).toBe('grid');
    expect(current(visit.host)?.dataset.layoutSource).toBe('url');

    const defaults = [...visit.host.querySelectorAll('a')].find(
      (node) => node.textContent?.trim() === m.library_shelf_restore_defaults(),
    )!;
    expect(searchParams(defaults.href)).toEqual({ type: book, state: 'planned' });
    await act(async () => visit.router.navigate({ to: '/library', search: searchParams(defaults.href) as never }));
    await tick();
    expect(current(visit.host)?.dataset.layout).toBe('table');
    expect(current(visit.host)?.dataset.layoutSource).toBe('type');
    expect(current(visit.host)?.dataset.sort).toBe('personalScore:asc');
  } finally {
    readTypes.mockRestore();
    await visit.close();
  }
});

test('same-account ABA retires the visit through route variants, while a fresh admitted visit can bind a new generation', async () => {
  const visit = await mountVisit(personalData(snapshot('aba-old')), new URLSearchParams({ type: book }).toString());
  const setSession = (token: string) =>
    visit.client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken: token });
  const originalObservation = browserObservation(visit.client).getSnapshot();
  let originalReaderId: number | undefined;
  if (originalObservation.state === 'signed-in') originalReaderId = originalObservation.observation.id;
  try {
    expect(current(visit.host)?.dataset.layout).toBe('table');
    setSession('reader-token-b');
    await tick();
    expect(current(visit.host)?.dataset.layout).toBe('grid');
    setSession(csrfToken);
    await tick();
    expect(current(visit.host)?.dataset.layout).toBe('grid');

    await visit.render({ addressRecovery: ['type'] });
    expect(visit.host.textContent).toContain(m.library_shelf_address_invalid_title());
    await visit.render({ sessionUnavailable: true, signInHref: '/en/sign-in' });
    expect(visit.host.textContent).toContain(m.shell_account_unavailable());
    await visit.render(personalData(snapshot('aba-fresh')));
    expect(current(visit.host)?.dataset.layout).toBe('grid');
    await visit.render({
      state: 'closed',
      provenance: {
        subject: accountId,
        locale: 'en',
        source: { labelId, cursor: null, undo: null, labelResult: null, undoKey: null },
      },
      shelfSnapshot: snapshot('aba-fresh'),
    } as BoundaryData);
    expect(visit.host.textContent).toContain(m.library_heading());
    await visit.render(personalData(snapshot('aba-fresh')));
    expect(current(visit.host)?.dataset.layout).toBe('grid');
  } finally {
    await visit.close(false);
  }

  expect(browserObservation(visit.client).getSnapshot().state).toBe('inactive');
  const staleVisit = await mountVisit(
    personalData(snapshot('aba-old')),
    new URLSearchParams({ type: book }).toString(),
    visit.client,
  );
  try {
    expect(current(staleVisit.host)?.dataset.layout).toBe('grid');
  } finally {
    await staleVisit.close(false);
  }
  const newVisit = await mountVisit(
    personalData(snapshot('aba-fresh')),
    new URLSearchParams({ type: book }).toString(),
    visit.client,
  );
  try {
    expect(current(newVisit.host)?.dataset.layout).toBe('table');
    const freshObservation = browserObservation(newVisit.client).getSnapshot();
    expect(freshObservation.state).toBe('signed-in');
    if (freshObservation.state !== 'signed-in' || originalReaderId === undefined)
      throw new Error('Fresh Library visit did not observe a new reader incarnation');
    expect(freshObservation.observation.id).not.toBe(originalReaderId);
  } finally {
    await newVisit.close();
  }
});

test('removed, failed, and pending session observations retire each mounted Library snapshot', async () => {
  for (const [index, mode] of (['removed', 'failed', 'pending'] as const).entries()) {
    const visit = await mountVisit(personalData(snapshot(`session-${mode}-${index}`)), new URLSearchParams({ type: book }).toString());
    try {
      expect(current(visit.host)?.dataset.layout).toBe('table');
      const query = visit.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      expect(query).toBeDefined();
      if (mode === 'removed') {
        visit.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      } else if (mode === 'failed') {
        query!.setState({ ...query!.state, status: 'error', error: new Error('session unavailable'), fetchStatus: 'idle' });
      } else {
        query!.setState({ ...query!.state, data: undefined, status: 'pending', error: null, fetchStatus: 'fetching' });
      }
      await tick();
      expect(current(visit.host)?.dataset.layout).toBe('grid');
      visit.client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken });
      await tick();
      expect(current(visit.host)?.dataset.layout).toBe('grid');
    } finally {
      await visit.close();
    }
  }
});
