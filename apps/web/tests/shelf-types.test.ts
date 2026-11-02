import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import definitions from '../src/kernel/recorded/definitions-release.json';

// One source outcome using the existing default page/adapter DOM harness. Native and browser proof are separate.
test('a reader chooses an indexed Type absent from loaded entries, retains the native predicate and display, and recovers no matches and picker failure', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const canonical = window.document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://site.test/en/library';
  window.document.head.append(canonical);
  const originalFetch = globalThis.fetch;
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const credential = async () => ({
    status: 'active',
    subject: id(700),
    accessToken: 'owner-token',
    csrfToken: 'a'.repeat(22),
  });
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:list progress_session:list',
    WEBSITE_CLIENT_ID: 'shelf-types-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (value: string) => value, get: () => ({ credential, credentialIfFresh: credential }) },
  };
  let address = '/en/library?state=planned&layout=list&size=l&cursor=entry-initial';
  const request = () =>
    new Request(new URL(address, 'https://site.test'), {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  const cacheHeaders: string[] = [];
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: request,
    setResponseHeader(name: string, value: string) {
      if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
    },
  }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const reads: { path: string; query: Record<string, string>; authorization: string | null }[] = [];
  let typesFailure = false;
  let stale = false;
  const raw = (n: number, type: string) => ({
    subjectId: id(n),
    state: 'planned',
    revision: 1,
    incarnationId: id(n + 100),
    createdAt: '2026-01-01T00:00:00.000001Z',
    updatedAt: '2026-01-01T00:00:00.000001Z',
    lastActivityAt: '2026-01-01T00:00:00.000001Z',
    finishedAt: null,
    activeProgressSession: null,
    subject: { id: id(n), type, types: [type], label: { value: `Work ${n}`, language: 'en' }, cover: null },
  });
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname.startsWith('/v1/definitionTypes/')) {
      const typeId = decodeURIComponent(url.pathname.slice('/v1/definitionTypes/'.length));
      const definition = definitions.release.types[typeId as keyof typeof definitions.release.types];
      if (!definition) return new Response(null, { status: 404 });
      return Response.json({
        typeId,
        releaseDigest: definitions.digest,
        label: definition.labels.en,
        language: 'en',
        definition,
      });
    }
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    if (url.pathname === '/v1/platform/exposure')
      return Response.json({ admitted: ['personal_library', 'reading_progress'] });
    if (url.pathname === '/openapi.json') return Response.json({ paths: {} });
    if (url.pathname === '/v1/collections') return Response.json({ collections: [], next: null });
    if (url.pathname === '/v1/libraryContinue') return Response.json({ subjects: [], next: null });
    if (!['/v1/libraryEntries', '/v1/libraryShelfTypes'].includes(url.pathname))
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    expect(req.method).toBe('GET');
    reads.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.get('authorization'),
    });
    if (url.pathname === '/v1/libraryShelfTypes') {
      expect(url.searchParams.get('limit')).toBe('20');
      expect([...url.searchParams.keys()].sort()).toEqual(
        url.searchParams.has('cursor') ? ['cursor', 'limit'] : ['limit'],
      );
      if (typesFailure) return Response.json({ code: 'unavailable' }, { status: 503 });
      return Response.json(
        url.searchParams.has('cursor')
          ? { types: [{ type: 'schema:Movie', count: 203 }], next: null }
          : { types: [{ type: 'schema:Book', count: 604 }], next: 'types-second' },
      );
    }
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('view')).toBe('FULL');
    expect(url.searchParams.get('cursor')).not.toBe('types-second');
    if (stale && url.searchParams.has('cursor')) {
      stale = false;
      return Response.json({ code: 'stale_cursor' }, { status: 409 });
    }
    const selected = url.searchParams.get('type');
    return Response.json({
      libraryEntries:
        url.searchParams.get('state') === 'paused' ? [] : [raw(selected ? 2 : 1, selected ?? 'schema:Book')],
      next: url.searchParams.has('cursor') ? null : 'entry-movies',
    });
  }) as typeof fetch;
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { Route: libraryRoute } = await import('../src/routes/library/index');
  const { readPersonalLibrary } = await import('../src/library/entries-actions');
  const { readShelfTypes } = await import('../src/library/shelf-types-read');
  const { validateShelfSearch, shelfHref, shelfDisplay } = await import('../src/library/shelf-params');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id(700), csrfToken: 'a'.repeat(22) });
  client.setQueryData(exposureQuery.queryKey, ['personal_library', 'reading_progress']);
  const base = createRootRouteWithContext<{ queryClient: typeof client }>()({ component: Outlet });
  libraryRoute.update({ id: '/library/', path: '/library/', getParentRoute: () => base } as never);
  const router = createRouter({
    routeTree: base.addChildren([libraryRoute]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [address.replace('/en/', '/')] }),
  });
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const counts = () => [
    reads.filter((r) => r.path === '/v1/libraryEntries').length,
    reads.filter((r) => r.path === '/v1/libraryShelfTypes').length,
  ];
  const latest = () => reads.filter((r) => r.path === '/v1/libraryEntries').at(-1)!.query;
  const button = (name: string) =>
    Array.from(window.document.querySelectorAll('button')).find((node) => node.textContent === name)!;
  const link = (name: string) =>
    Array.from(window.document.querySelectorAll('a')).find((node) => node.textContent === name)!;
  const click = async (name: string) => {
    await act(async () => button(name).click());
  };
  const go = async (href: string) => {
    const url = new URL(href, 'https://site.test');
    address = '/en' + url.pathname.replace(/^\/en(?=\/)/, '') + url.search;
    await act(async () => {
      await router.navigate({ href: address.replace('/en/', '/') });
    });
  };
  try {
    await router.load();
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
        ),
      ),
    );
    expect(host.textContent).toContain('Work 1');
    expect(host.textContent).not.toContain('Work 2');
    expect(counts()).toEqual([1, 0]);
    await click(m.library_type_action({ type: m.library_types_all() }));
    expect(counts()).toEqual([1, 1]);
    await click(m.library_types_next());
    expect(counts()).toEqual([1, 2]);
    const dialog = window.document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('nav a')).toHaveLength(1);
    expect(dialog.textContent).toContain('Film');
    expect(dialog.textContent).not.toContain('Book');
    expect(dialog.textContent).not.toContain('203');
    await go(link('Film').getAttribute('href')!);
    expect(latest()).toEqual({
      type: 'schema:Movie',
      state: 'planned',
      orderBy: 'createdAt',
      direction: 'desc',
      limit: '100',
      view: 'FULL',
    });
    expect(counts()).toEqual([2, 2]);
    expect(host.textContent).toContain('Work 2');
    // Next is the entry keyset, never the independently held Type-index token.
    await go(link(m.library_next_page()).getAttribute('href')!);
    expect(latest().cursor).toBe('entry-movies');
    expect(latest().type).toBe('schema:Movie');
    expect(counts()).toEqual([3, 2]);
    // Display changes retain the keyset and do not issue source calls.
    await go(
      shelfHref('en', {
        ...validateShelfSearch(Object.fromEntries(new URL(address, 'https://site.test').searchParams)),
        layout: 'grid',
        size: 's',
      }),
    );
    expect(new URL(address, 'https://site.test').searchParams.get('cursor')).toBe('entry-movies');
    expect(counts()).toEqual([3, 2]);
    // Submit the actual ordinary GET form: it contains the Type but no old cursor.
    const form = host.querySelector<HTMLFormElement>('form[method="get"]')!;
    expect(form.querySelector('input[name="type"]')?.getAttribute('value')).toBe('schema:Movie');
    expect(form.querySelector('[name="cursor"]')).toBeNull();
    form.querySelector<HTMLSelectElement>('select[name="orderBy"]')!.value = 'finishedAt';
    form.querySelector<HTMLSelectElement>('select[name="direction"]')!.value = 'asc';
    const formSearch = new URLSearchParams();
    for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')))
      formSearch.set(input.name, input.value);
    await go(`/en/library?${formSearch}`);
    expect(latest()).toMatchObject({ type: 'schema:Movie', state: 'planned', orderBy: 'finishedAt', direction: 'asc' });
    expect(latest().cursor).toBeUndefined();
    expect(counts()).toEqual([4, 2]);
    await act(async () => {
      await router.invalidate();
    });
    expect(latest().type).toBe('schema:Movie');
    expect(counts()).toEqual([5, 2]);
    stale = true;
    await go(link(m.library_next_page()).getAttribute('href')!);
    expect(counts()).toEqual([7, 2]);
    expect(
      reads
        .filter((r) => r.path === '/v1/libraryEntries')
        .slice(-2)
        .map((r) => r.query.type),
    ).toEqual(['schema:Movie', 'schema:Movie']);
    expect(latest().cursor).toBeUndefined();
    // Changing the exact state composes with Type and resets selection captured on the old predicate.
    await click(m.library_selection_page());
    await go('/en/library?type=schema%3AMovie&state=paused&orderBy=finishedAt&direction=asc&layout=grid&size=s');
    expect(counts()).toEqual([8, 2]);
    expect(host.textContent).toContain(m.library_type_empty_title({ type: 'Film' }));
    expect(host.textContent).not.toContain(m.library_empty_title());
    expect(host.querySelector('[data-selection-outcome]')).toBeNull();
    // A failed picker preserves this no-match predicate/display and has a genuine bounded retry.
    typesFailure = true;
    await click(m.library_type_action({ type: 'Film' }));
    expect(counts()).toEqual([8, 3]);
    expect(window.document.body.textContent).toContain(m.library_types_unavailable());
    await click(m.library_types_retry());
    expect(counts()).toEqual([8, 4]);
    expect(window.document.body.textContent).not.toContain(m.library_types_empty());
    typesFailure = false;
    await click(m.library_types_retry());
    expect(counts()).toEqual([8, 5]);
    expect(window.document.querySelector('[role="dialog"]')!.textContent).toContain('Type: Film');
    expect(window.document.querySelector('[role="dialog"]')!.textContent).toContain('Book');
    await go(link(m.library_types_all()).getAttribute('href')!);
    expect(counts()).toEqual([9, 5]);
    expect(latest()).toEqual({ state: 'paused', orderBy: 'finishedAt', direction: 'asc', limit: '100', view: 'FULL' });
    expect(
      shelfDisplay(validateShelfSearch(Object.fromEntries(new URL(address, 'https://site.test').searchParams))),
    ).toEqual({ layout: 'grid', size: 's' });
    expect(reads.every((r) => r.authorization === 'Bearer owner-token')).toBe(true);
    expect(cacheHeaders.length).toBeGreaterThan(0);
    expect(cacheHeaders.every((value) => value === 'private, no-store')).toBe(true);
    // The server boundary also drops malformed/oversized Type values before native reads.
    for (const type of ['schema:Book\n', 'Book', 'schema:' + 'a'.repeat(2049)]) {
      await readPersonalLibrary({ data: { type, orderBy: 'lastActivity' } });
      expect(latest().type).toBeUndefined();
    }
    const label = id(800);
    expect(validateShelfSearch({ type: 'schema:Movie', label, orderBy: 'finishedAt' })).toEqual({ label });
    expect(shelfHref('en', { type: 'schema:Movie', label })).not.toContain('type=');
    const beforeInvalidCursor = counts();
    await expect(Promise.resolve().then(() => readShelfTypes({ data: { cursor: 'x'.repeat(4097) } }))).rejects.toThrow(
      'Invalid Type cursor',
    );
    expect(counts()).toEqual(beforeInvalidCursor);
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
