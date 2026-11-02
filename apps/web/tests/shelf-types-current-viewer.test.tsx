import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { ShelfSearch } from '../src/library/shelf-params';

// UNRUN: focused server/default-composition regressions for integration, using the existing DOM/Query fixture.
// These assertions are separate from deferred native, browser and whole-Goal acceptance.
const A = '019a2100-0000-7000-8000-000000000001';
const B = '019a2100-0000-7000-8000-000000000002';
let preparedSubject: string | undefined = A;
let preparation: 'active' | 'absent' = 'active';
let preparations = 0;
let address = '/en/library';
const request = () =>
  new Request(`https://site.test${address}`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let actualRequest = request();
const headers = new Headers();
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => {
        preparations++;
        return preparation === 'absent'
          ? { status: 'absent' }
          : {
              status: 'active',
              subject: preparedSubject,
              accessToken: `prepared-${preparations}`,
              csrfToken: 'csrf',
            };
      },
      // A separate identity read would disagree. The chooser must use the preparation supplying its GET.
      signedIn: async () => ({ signedIn: true, subject: B, csrfToken: 'identity-csrf' }),
    }),
  },
};
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => actualRequest,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
afterAll(() => mock.restore());
const readers = await import('../src/library/shelf-types-read');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('the current reader records actual same-Request preparation and bounded provenance even for empty success', async () => {
  preparations = 0;
  preparedSubject = A;
  preparation = 'active';
  address = '/en/library';
  actualRequest = request();
  const calls: Request[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    if (new URL(call.url).pathname.startsWith('/v1/definitions/'))
      return Response.json({ code: 'unavailable' }, { status: 503 });
    return Response.json({ types: [], next: null });
  });
  try {
    const empty = await readers.readShelfTypesCurrent({ data: { cursor: 'signed/next+cursor' } });
    expect(empty).toEqual({
      sessionSubject: A,
      authorizationAgrees: true,
      requested: { cursor: 'signed/next+cursor', limit: 20, locale: 'en' },
      page: { state: 'loaded', types: [], next: null },
    });
    expect(preparations).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer prepared-1');
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
      limit: '20',
      cursor: 'signed/next+cursor',
    });
    expect(calls[0]!.cache).toBe('no-store');
    expect(calls[0]!.redirect).toBe('manual');
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(empty)).not.toContain('prepared-1');
    actualRequest = request();
    preparedSubject = undefined;
    expect((await readers.readShelfTypesCurrent({ data: {} })).page).toEqual({ state: 'unavailable' });
    expect(calls).toHaveLength(1);
    preparedSubject = A;
    preparation = 'absent';
    expect(await readers.readShelfTypesCurrent({ data: {} })).toMatchObject({
      sessionSubject: null,
      authorizationAgrees: false,
      page: { state: 'signed-out' },
    });
    expect(calls).toHaveLength(1);
    preparation = 'active';
    actualRequest = new Request('https://site.test/en/library', { headers: { authorization: 'Bearer explicit' } });
    expect((await readers.readShelfTypesCurrent({ data: {} })).page).toEqual({ state: 'unavailable' });
    expect(calls).toHaveLength(1);
    // Existing pure bearer readers retain their result shape and single native request.
    expect(await readers.loadShelfTypes(createKernelClient(env.KERNEL_ORIGIN), actualRequest, {}, {})).toEqual({
      state: 'loaded',
      types: [],
      next: null,
    });
    expect(calls).toHaveLength(2);
    await expect(
      Promise.resolve().then(() => readers.readShelfTypesCurrent({ data: { cursor: 'x'.repeat(4097) } })),
    ).rejects.toThrow('Invalid Type cursor');
    expect(calls).toHaveLength(2);
  } finally {
    transport.mockRestore();
  }
});

test('Whole Shelf type chooser binds actual same-read viewer and cursor provenance and retires choices and callbacks on observed viewer admission or address replacement', async () => {
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
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
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
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { ShelfTypes } = await import('../src/library/shelf-types');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const viewer = (subject: string | null, state: 'signed-in' | 'signed-out' | 'unknown' = 'signed-in') => ({
    state,
    subject,
    csrfToken: 'csrf',
  });
  client.setQueryData(sessionQuery.queryKey, viewer(A));
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
  let view: ShelfSearch = {
    state: 'planned',
    orderBy: 'createdAt',
    direction: 'asc',
    layout: 'list',
    size: 'l',
    columns: 'title,type',
    cursor: 'entries-cursor',
  };
  let locale = 'en';
  let repaint: (() => void) | undefined;
  const route = createRootRoute({
    component: function Page() {
      const [, update] = useState(0);
      repaint = () => update((value) => value + 1);
      return <ShelfTypes locale={locale} view={view} />;
    },
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/library'] }) });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const reads: { request: Request; work: ReturnType<typeof deferred<Response>> }[] = [];
  let namesFail = true;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    const path = new URL(call.url).pathname;
    if (path.startsWith('/v1/definitionTypes/')) {
      if (namesFail) return new Response(null, { status: 503 });
      const typeId = decodeURIComponent(path.slice('/v1/definitionTypes/'.length));
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
    if (path === '/v1/definitions/active')
      return namesFail ? new Response(null, { status: 503 }) : Response.json({ digest: definitions.digest });
    if (path.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    if (path === '/v1/libraryShelfTypes') {
      const work = deferred<Response>();
      reads.push({ request: call, work });
      return work.promise;
    }
    throw new Error(`Unexpected chooser IO: ${path}`);
  });
  const render = async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  };
  const button = (label: string) =>
    [...window.document.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const trigger = () => button(m.library_type_action({ type: m.library_types_all() }));
  const click = async (node: { click(): void }) => {
    await act(async () => node.click());
  };
  const retained = (node: object) => {
    const key = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactProps$'))!;
    const callback = (node as Record<string, { onClick(event: unknown): void }>)[key]!.onClick;
    return (_event?: unknown) =>
      callback({
        nativeEvent: new window.MouseEvent('click', { bubbles: true }),
        currentTarget: node,
        target: node,
        button: 0,
        detail: 1,
        preventDefault() {},
        stopPropagation() {},
        isPropagationStopped: () => false,
        isDefaultPrevented: () => false,
      });
  };
  const complete = async (index: number, types: string[], next: string | null = null, status = 200) => {
    await act(async () => {
      reads[index]!.work.resolve(
        status === 200
          ? Response.json({ types: types.map((type) => ({ type, count: 804 })), next })
          : Response.json({ code: 'unavailable' }, { status }),
      );
    });
  };
  const begin = async () => {
    actualRequest = request();
    await click(trigger());
  };
  let unmounted = false;
  try {
    preparation = 'active';
    preparedSubject = A;
    address = '/en/library';
    await router.load();
    await render();
    expect(reads).toHaveLength(0);
    await begin();
    expect(reads).toHaveLength(1);
    await complete(0, ['schema:Book'], 'signed/types+next');
    expect(window.document.body.textContent).toContain(m.library_type_unnamed_option({ position: 1 }));
    expect(window.document.body.textContent).toContain(m.library_type_name_unavailable());
    expect(window.document.body.textContent).not.toContain('804');
    const firstNext = retained(button(m.library_types_next()));
    await act(async () => {
      firstNext({ preventDefault() {} });
      firstNext({ preventDefault() {} });
    });
    expect(reads).toHaveLength(2);
    expect(new URL(reads[1]!.request.url).searchParams.get('cursor')).toBe('signed/types+next');
    await complete(1, [], null, 503);
    const retry = retained(button(m.library_types_retry()));
    namesFail = false;
    await click(button(m.library_types_retry()));
    expect(reads).toHaveLength(3);
    expect(new URL(reads[2]!.request.url).searchParams.get('cursor')).toBe('signed/types+next');
    await complete(2, ['schema:Movie']);
    expect(window.document.body.textContent).toContain('Film');
    const film = [...window.document.querySelectorAll('nav a')].find((node) => node.textContent === 'Film')!;
    const filmUrl = new URL(film.getAttribute('href')!, 'https://site.test');
    expect(Object.fromEntries(filmUrl.searchParams)).toEqual({
      type: 'schema:Movie',
      state: 'planned',
      orderBy: 'createdAt',
      direction: 'asc',
      layout: 'list',
      size: 'l',
      columns: 'title,type',
    });
    await click(button(m.library_types_first()));
    expect(new URL(reads[3]!.request.url).searchParams.has('cursor')).toBe(false);
    await complete(3, ['schema:Book'], 'fresh-next');

    // Admission ABA happens synchronously before React commits; retained next AND retry must refuse IO.
    await click(button(m.action_cancel()));
    await click(trigger());
    expect(reads).toHaveLength(4);
    const oldNext = retained(button(m.library_types_next()));
    await act(async () => {
      client.setQueryData(exposureQuery.queryKey, []);
      oldNext({ preventDefault() {} });
      retry({ preventDefault() {} });
      client.setQueryData(exposureQuery.queryKey, ['personal_library']);
      oldNext({ preventDefault() {} });
    });
    expect(reads).toHaveLength(4);
    expect(window.document.body.textContent).not.toContain('Book');
    await begin();
    await complete(4, ['schema:Book'], 'A-next');
    const viewerNext = retained(button(m.library_types_next()));
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer(B));
      client.setQueryData(sessionQuery.queryKey, viewer(A));
      viewerNext({ preventDefault() {} });
    });
    expect(reads).toHaveLength(5);
    expect(window.document.body.textContent).not.toContain('Book');

    // An actual prepared A cannot certify observed B, even when the native response is an empty success.
    await act(async () => client.setQueryData(sessionQuery.queryKey, viewer(B)));
    await begin();
    await complete(5, []);
    expect(window.document.body.textContent).not.toContain(m.library_types_empty());
    expect(window.document.body.textContent).toContain(m.library_types_unavailable());
    const mismatchRetry = retained(button(m.library_types_retry()));
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer(null));
      mismatchRetry({ preventDefault() {} });
      client.setQueryData(sessionQuery.queryKey, viewer(A));
    });
    expect(reads).toHaveLength(6);
    await begin(); // A remains unresolved while B starts and finishes its own read.
    const pendingA = 6;
    const aTrigger = retained(trigger());
    await act(async () => client.setQueryData(sessionQuery.queryKey, viewer(B)));
    preparedSubject = B;
    await begin();
    expect(reads).toHaveLength(8);
    await complete(7, ['schema:Movie'], 'B-next');
    expect(window.document.body.textContent).toContain('Film');
    await click(button(m.library_types_next()));
    expect(reads).toHaveLength(9);
    await complete(pendingA, ['schema:Book'], 'obsolete-A');
    expect(window.document.body.textContent).toContain(m.library_types_loading());
    expect(window.document.body.textContent).not.toContain('Book');
    await complete(8, ['schema:Movie'], 'B-next-again');
    const bNext = retained(button(m.library_types_next()));
    await act(async () => aTrigger({ preventDefault() {} }));
    expect(reads).toHaveLength(9);

    // Actual address ABA is observed by the router before the replacement page commit.
    await act(async () => {
      await router.navigate({ href: '/library?state=paused' });
      bNext({ preventDefault() {} });
      await router.navigate({ href: '/library' });
      bNext({ preventDefault() {} });
    });
    expect(reads).toHaveLength(9);
    expect(window.document.body.textContent).not.toContain('Film');
    view = { ...view, state: 'paused' };
    locale = 'zh-Hant';
    address = '/zh-Hant/library';
    await act(async () => repaint!());
    await begin();
    await complete(9, []);
    expect(window.document.body.textContent).toContain(m.library_types_empty());
    // Sign-out/unknown retire choices; unmount also fences a retained callback and late finally.
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer(null, 'signed-out'));
      client.setQueryData(sessionQuery.queryKey, viewer(null, 'unknown'));
      client.setQueryData(sessionQuery.queryKey, viewer(B));
    });
    await begin();
    const beforeUnmount = retained(trigger());
    await act(async () => root.unmount());
    unmounted = true;
    await act(async () => beforeUnmount({ preventDefault() {} }));
    expect(reads).toHaveLength(11);
    await complete(10, ['schema:Book'], 'unmounted');
    expect(window.document.body.textContent).not.toContain('Book');
    expect(
      reads.every(
        ({ request }) =>
          request.cache === 'no-store' &&
          request.redirect === 'manual' &&
          new URL(request.url).searchParams.get('limit') === '20',
      ),
    ).toBe(true);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    client.clear();
    transport.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
