import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import definitions from '../src/kernel/recorded/definitions-release.json';

// Default route and HTTP adapters, with constructed responses. This is not native acceptance evidence.
// Intentionally unrun under minimal verification; the controller owns the focused outcome gate.
test('a reader chooses personal Library table columns on the actual page and retains them through reload and navigation without extra native queries or mutations', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/library', width: 1280, height: 900 });
  const canonical = window.document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://site.test/en/library';
  window.document.head.append(canonical);
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFieldSetElement: window.HTMLFieldSetElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const csrfToken = 'a'.repeat(22);
  const admitted = ['personal_library', 'reading_progress', 'library_entry.restore'];
  const credential = async () => ({ status: 'active', subject: id(700), accessToken: 'owner-token', csrfToken });
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:read library_entry:update',
    WEBSITE_CLIENT_ID: 'columns-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (value: string) => value, get: () => ({ credential, credentialIfFresh: credential }) },
  };
  const request = (method = 'GET', headers?: HeadersInit) =>
    new Request('https://site.test/en/library', {
      method,
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin: 'https://site.test',
        ...Object.fromEntries(new Headers(headers)),
      },
    });
  let currentRequest = request();
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => ({
    ...start,
    createServerFn(options: { method?: string } = {}) {
      const chain = start.createServerFn();
      return {
        ...chain,
        validator(validate: (input: unknown) => unknown) {
          chain.validator(validate);
          return this;
        },
        handler(handler: (...args: never[]) => unknown) {
          const execute = chain.handler(handler);
          return (input?: { headers?: HeadersInit }) => {
            currentRequest = request(options.method ?? 'GET', input?.headers);
            return execute(input as never);
          };
        },
      };
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => currentRequest, setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const { libraryStateOptions } = await import('../src/library/profiles');
  const { m } = await import('../src/paraglide/messages.js');
  const { shelfColumnIds } = await import('../src/library/shelf-params');
  const { shelfColumnLabel } = await import('../src/library/shelf-columns');
  const { Route } = await import('../src/routes/library/index');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { createRoot } = await import('react-dom/client');
  const options = libraryStateOptions(definitions.release as never, 'schema:Book', 'en');
  const stamp = '2026-01-01T00:00:00.000Z';
  const row = (n: number) => ({
    subjectId: id(n),
    state: options[0]!.id,
    revision: 2,
    incarnationId: id(900 + n),
    createdAt: stamp,
    updatedAt: stamp,
    lastActivityAt: stamp,
    finishedAt: null,
      ...(n === 1
        ? {
            activeProgressSession: {
              mode: 'cursor_position',
              unit: 'page',
              amount: null,
              total: '99',
              completedUnitCount: 0,
              locator: null,
              position: '12',
            },
          }
        : {}),
    subject:
      n === 2
        ? null
        : {
            id: id(n),
            type: 'schema:Book',
            types: ['schema:Book'],
            label: { value: 'A private library entry', language: 'en' },
            cover: null,
          },
  });
  let rows = [row(1), row(2)];
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    requests.push(req);
    const url = new URL(req.url);
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
    if (url.pathname === `/v1/accounts/${id(700)}/preferences`)
      return Response.json({
        version: 3,
        spoilerLevel: 0,
        suitability: 'blur',
        notifications: { reply: true, mention: true },
        shelf: {
          layouts: { all: 'table' },
          sorts: { all: { field: 'last_activity', direction: 'desc' } },
          gridSize: 'medium',
          tableColumns: ['cover', 'title', 'type', 'status', 'progress', 'added', 'finished', 'last_activity'],
        },
      });
    if (url.pathname === '/v1/libraryEntries') return Response.json({ libraryEntries: rows, next: 'native-next' });
    if (url.pathname === '/v1/libraryContinue') return Response.json({ subjects: [], next: null });
    if (url.pathname === '/openapi.json') return Response.json({ paths: {} });
    if (url.pathname === '/v1/collections') return Response.json({ collections: [], next: null });
    return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  }) as typeof fetch;
  const reads = () => requests.filter((req) => new URL(req.url).pathname === '/v1/libraryEntries');
  const preferenceReads = () =>
    requests.filter((req) => new URL(req.url).pathname === `/v1/accounts/${id(700)}/preferences` && req.method === 'GET');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id(700), csrfToken });
  client.setQueryData(exposureQuery.queryKey, admitted);
  const routeRoot = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()();
  const libraryRoute = Route.update({ id: '/library/', path: '/library', getParentRoute: () => routeRoot } as never);
  const routeTree = routeRoot.addChildren([libraryRoute]);
  const makeRouter = (url: string) =>
    createRouter({
      routeTree,
      context: { queryClient: client },
      history: createMemoryHistory({ initialEntries: [url] }),
    });
  let router = makeRouter(
    '/library?layout=table&orderBy=createdAt&direction=asc&cursor=native-current&columns=rating,title',
  );
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  let root = createRoot(host);
  const render = async () => {
    await act(async () => {
      await router.load();
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
  };
  const table = () => host.querySelector('table')!;
  const headers = () => Array.from(table().querySelectorAll('th')).map((node) => node.textContent);
  const button = (label: string, scope: ParentNode = host) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    )!;
  const click = async (node: HTMLElement) => {
    expect(node).toBeDefined();
    await act(async () => node.click());
  };
  const openPicker = async () => {
    await click(button(m.library_columns()));
    return window.document.querySelector('[role="dialog"][aria-label="' + m.library_columns() + '"]')!;
  };
  const toggle = async (column: string) => {
    const picker =
      window.document.querySelector('[role="dialog"][aria-label="' + m.library_columns() + '"]') ??
      (await openPicker());
    const label = Array.from(picker.querySelectorAll('label')).find(
      (node) => node.textContent === shelfColumnLabel(column as never),
    )!;
    await click(window.document.getElementById(label.htmlFor)! as unknown as HTMLElement);
  };
  const close = async () => {
    await act(async () =>
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
  };
  const search = () => new URL(router.state.location.href, 'https://site.test').searchParams;
  const go = async (value: Record<string, unknown>) => {
    await act(async () => {
      await router.navigate({ to: '/library', search: value as never });
    });
  };
  const follow = async (label: string) => {
    const link = Array.from(host.querySelectorAll<HTMLAnchorElement>('a')).find((node) => node.textContent === label)!;
    expect(link).toBeDefined();
    await go(Object.fromEntries(new URL(link.href, 'https://site.test').searchParams));
  };
  try {
    await render();
    expect(headers()).toEqual(shelfColumnIds.map(shelfColumnLabel)); // malformed means complete current defaults
    expect(table().textContent).toContain('12 / 99');
    expect(reads()).toHaveLength(1);
    expect(preferenceReads()).toHaveLength(1);
    const initialQuery = new URL(reads()[0]!.url).search;
    expect(new URLSearchParams(initialQuery).get('cursor')).toBe('native-current');
    expect(new URLSearchParams(initialQuery).has('columns')).toBe(false);
    const initialRequests = requests.length;
    const picker = await openPicker();
    expect(picker.querySelectorAll('[role="checkbox"]')).toHaveLength(8);
    const titleLabel = Array.from(picker.querySelectorAll('label')).find(
      (node) => node.textContent === m.library_column_title(),
    )!;
    const titleChoice = window.document.getElementById(titleLabel.htmlFor)!;
    expect(titleChoice.getAttribute('aria-checked')).toBe('true');
    expect(titleChoice.hasAttribute('disabled') || titleChoice.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(picker.textContent).toContain(m.library_columns_title_required());
    for (const column of ['lastActivity', 'cover', 'type', 'progress', 'added', 'finished']) await toggle(column);
    await close();
    expect(search().get('columns')).toBe('title,status');
    expect(search().get('cursor')).toBe('native-current');
    expect(headers()).toEqual([m.library_column_title(), m.library_column_status()]);
    expect(reads()).toHaveLength(1);
    expect(requests).toHaveLength(initialRequests);
    const action = button(m.library_entry_actions({ title: 'A private library entry' }), table());
    await click(action);
    expect(window.document.querySelector('[role="menu"]')!.textContent).toContain(m.library_menu_status());
    expect(window.document.querySelector('[role="menu"]')!.textContent).toContain(m.library_remove_from_library());
    await close();
    expect(button(m.library_entry_actions({ title: m.library_subject_unavailable() }), table())).toBeDefined();
    // The existing form still carries the exact native incarnation and key.
    const remove = host.querySelector('noscript form')!;
    expect(remove.querySelector<HTMLInputElement>('[name="incarnationId"]')!.value).toBe(id(901));
    expect(remove.querySelector<HTMLInputElement>('[name="idempotencyKey"]')!.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(remove.querySelector<HTMLInputElement>('[name="returnTo"]')!.value).toContain('columns=title%2Cstatus');
    // A new router/document reads the same native page and reconstructs the chosen display from its URL.
    const retained = router.state.location.href;
    await act(async () => root.unmount());
    router = makeRouter(retained);
    root = createRoot(host);
    await render();
    expect(headers()).toEqual([m.library_column_title(), m.library_column_status()]);
    expect(reads()).toHaveLength(2);
    expect(new URL(reads()[1]!.url).search).toBe(initialQuery);
    const reloadedRequests = requests.length;
    await click(button(m.library_layout_list()));
    expect(host.querySelector('table')).toBeNull();
    expect(button(m.library_columns())).toBeUndefined();
    await click(button(m.library_layout_grid()));
    await click(button(m.library_size_small()));
    await click(button(m.library_layout_table()));
    expect(search().get('columns')).toBe('title,status');
    expect(search().get('cursor')).toBe('native-current');
    expect(headers()).toEqual([m.library_column_title(), m.library_column_status()]);
    expect(reads()).toHaveLength(2);
    expect(requests).toHaveLength(reloadedRequests);
    // Column changes keep selection on these same loaded rows and send no mutation.
    await click(button(m.library_selection_page()));
    expect(host.textContent).toContain(m.library_selection_count({ count: 1 }));
    await toggle('status');
    await close();
    expect(search().get('columns')).toBe('title');
    expect(host.textContent).toContain(m.library_selection_count({ count: 1 }));
    await click(button(m.library_selection_clear()));
    expect(headers()).toEqual([m.library_column_title(), m.library_column_actions()]);
    expect(button(m.library_entry_actions({ title: 'A private library entry' }), table())).toBeDefined();
    expect(requests).toHaveLength(reloadedRequests);
    const titleOnly = router.state.location.href;
    await toggle('finished');
    await close();
    expect(host.querySelector('form[method="get"] input[name="columns"]')!.getAttribute('value')).toBe(
      'title,finished',
    );
    await click(button(m.library_sort_finished(), table()));
    expect(search().has('cursor')).toBe(false);
    expect(search().get('columns')).toBe('title,finished');
    expect(new URL(reads().at(-1)!.url).searchParams.get('orderBy')).toBe('finishedAt');
    await toggle('status');
    await close();
    const statusLink = table().querySelector<HTMLAnchorElement>('a.underline')!;
    await go(Object.fromEntries(new URL(statusLink.href).searchParams));
    expect(search().get('columns')).toBe('title,status,finished');
    expect(search().get('orderBy')).toBe('finishedAt');
    expect(search().has('cursor')).toBe(false);
    await follow(m.library_next_page());
    expect(search().get('cursor')).toBe('native-next');
    expect(search().get('columns')).toBe('title,status,finished');
    await follow(m.library_clear_state());
    expect(search().has('state')).toBe(false);
    expect(search().has('cursor')).toBe(false);
    expect(search().get('columns')).toBe('title,status,finished');
    // Canonicalization, malformed bounds and defaults remain visible outcomes in this same page journey.
    for (const columns of ['finished,title,title,status', 'unknown', 'cover,'.repeat(30)]) {
      await go({ ...router.state.location.search, columns });
      expect(headers()).toEqual(
        columns.startsWith('finished')
          ? [m.library_column_title(), m.library_column_status(), m.library_sort_finished()]
          : shelfColumnIds.map(shelfColumnLabel),
      );
    }
    await go({ ...router.state.location.search, columns: shelfColumnIds.toReversed().join(',') });
    expect(headers()).toEqual(shelfColumnIds.map(shelfColumnLabel));
    await go(Object.fromEntries(new URL(titleOnly, 'https://site.test').searchParams));
    expect(headers()).toEqual([m.library_column_title(), m.library_column_actions()]);
    await openPicker();
    await click(button(m.library_columns_reset(), window.document));
    await close();
    expect(search().has('columns')).toBe(false);
    expect(headers()).toEqual(shelfColumnIds.map(shelfColumnLabel));
    const count = reads().length;
    await act(async () => {
      router.history.back();
    });
    expect(search().get('columns')).toBe('title');
    expect(headers()).toEqual([m.library_column_title(), m.library_column_actions()]);
    expect(reads()).toHaveLength(count);
    expect(requests.filter((req) => req.method !== 'GET')).toHaveLength(0);
    expect(requests.filter((req) => /\/v1\/libraryEntries\//.test(req.url))).toHaveLength(0);
    expect(reads().every((req) => !new URL(req.url).searchParams.has('columns'))).toBe(true);
    for (const size of [1, 20, 100]) {
      rows = Array.from({ length: size }, (_, index) => row(index + 1));
      const before = reads().length;
      const preferencesBefore = preferenceReads().length;
      await act(async () => root.unmount());
      router = makeRouter('/library');
      root = createRoot(host);
      await render();
      expect(table().querySelectorAll('tbody tr')).toHaveLength(size);
      expect(reads()).toHaveLength(before + 1);
      expect(preferenceReads()).toHaveLength(preferencesBefore + 1);
      expect(requests.filter((req) => /\/v1\/libraryEntries\//.test(req.url))).toHaveLength(0);
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
