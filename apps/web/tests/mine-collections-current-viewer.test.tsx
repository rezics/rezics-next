import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { MenuProps } from '@rezics/ui/menu';
import * as start from '../.storybook/react-start';
import type { MineCollectionsViewerPage } from '../src/library/mine-collections-route';
import type { MineCollectionsSearch } from '../src/library/mine-collections-address';
import type { PinMutation } from '../src/library/pins-actions';

// UNRUN: one mounted/deferred journey for controller integration. The installed DOM and
// real exports exercise composition, not native authority, browser rendering or visual proof.
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let actualSubject: string | undefined = 'A';
let preparations = 0;
const headers = new Headers();
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        preparations++;
        return {
          status: preparation,
          accessToken: `credential-${actualSubject}`,
          subject: actualSubject,
          csrfToken: 'csrf',
        };
      },
    }),
  },
};
const request = () =>
  new Request('https://site.test/en/library/collections', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
afterAll(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(
  subject: string,
  cursor: string | null = null,
  layout: 'rows' | 'previews' = 'previews',
): MineCollectionsViewerPage {
  return {
    sessionSubject: subject,
    requested: { cursor, layout },
    page: {
      signedIn: true,
      state: 'loaded',
      next: `next-${subject}`,
      collections: [
        {
          id: 'shared-private',
          title: `Private ${subject}`,
          curator: null,
          visibility: 'private',
          preview: {
            state: 'loaded',
            members: [{ id: `subject-${subject}`, type: 'Book', label: `Preview ${subject}`, cover: null }],
          },
        },
      ],
      navigationCollections: [
        {
          id: `state-${subject}`,
          title: `Navigation ${subject}`,
          curator: null,
          membershipKind: 'dynamic',
          builtinKind: 'state',
        },
      ],
    },
    pins: {
      state: 'loaded',
      revision: 7,
      next: null,
      canUpdate: true,
      canRemove: true,
      pins: [{ collectionId: `pin-${subject}`, target: { id: `pin-${subject}`, title: `Pinned ${subject}` } }],
    },
  };
}

test('The default My Collections route immediately retires private collections and pins on observed viewer or request replacement and accepts only actual matching prepared-viewer results', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/collections?layout=previews' });
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
  const reads = await import('../src/library/mine-collections-route');
  const nativeCalls: Request[] = [];
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    nativeCalls.push(call);
    const url = new URL(call.url);
    expect(call.headers.get('authorization')).toBe('Bearer credential-A');
    expect(call.cache).toBe('no-store');
    expect(call.redirect).toBe('manual');
    if (url.pathname === '/v1/openapi.json')
      return Response.json({
        paths: {
          '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
          '/v1/libraryPins/{id}': {
            put: { operationId: 'library_pin.put' },
            delete: { operationId: 'library_pin.delete' },
          },
        },
      });
    if (url.pathname === '/v1/libraryPins') {
      expect(url.searchParams.get('limit')).toBe('100');
      return Response.json({ pins: [], revision: 7, next: null });
    }
    expect(url.pathname).toBe('/v1/collections');
    expect(url.searchParams.get('curatorAccountId')).toBe('A');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('preview')).toBe('3');
    return Response.json({ collections: [], next: null });
  });
  const { Route } = await import('../src/routes/library/collections');
  const { requireSignedIn } = await import('../src/session/guard');
  const load = Route.options.loader as (context: {
    deps: { cursor?: string; layout: 'previews' };
  }) => Promise<MineCollectionsViewerPage>;
  try {
    const cursor = 'opaque+/cursor==&private';
    const result = await reads.readMineCollectionsViewerPage({
      data: { cursor, layout: 'previews', sessionSubject: 'asserted-B' },
    });
    expect(result).toMatchObject({
      sessionSubject: 'A',
      requested: { cursor, layout: 'previews' },
      page: { signedIn: true },
      pins: { state: 'loaded' },
    });
    expect(preparations).toBe(1);
    expect(nativeCalls).toHaveLength(3);
    expect(
      new URL(nativeCalls.find((call) => new URL(call.url).pathname === '/v1/collections')!.url).searchParams.get(
        'cursor',
      ),
    ).toBe(cursor);
    expect(headers.get('cache-control')).toBe('private, no-store');
    preparation = 'absent'; // Refusal must win even over this Request's already cached subject/credential.
    const before = nativeCalls.length;
    expect(await load({ deps: { layout: 'previews' } })).toMatchObject({
      sessionSubject: null,
      page: { signedIn: false, collections: [] },
      pins: { state: 'closed' },
    });
    preparation = 'unavailable';
    await expect(load({ deps: { layout: 'previews' } })).rejects.toMatchObject({
      problem: { code: 'dependency_unavailable' },
    });
    preparation = 'active';
    actualSubject = undefined;
    currentRequest = request();
    expect(await reads.readMineCollectionsViewerPage({ data: { cursor: '' } })).toMatchObject({
      sessionSubject: null,
      requested: { cursor: null, layout: 'rows', addressError: { cursor: 'empty string' } },
      page: { signedIn: false, collections: [] },
      pins: { state: 'closed' },
    });
    currentRequest = new Request('https://site.test/en/library/collections', {
      headers: { authorization: 'Bearer browser-assertion' },
    });
    expect(await reads.readMineCollectionsViewerPage({ data: {} })).toMatchObject({
      sessionSubject: null,
      pins: { state: 'closed' },
    });
    expect(nativeCalls).toHaveLength(before);
    expect(Route.options.beforeLoad).toBe(requireSignedIn);
  } finally {
    native.mockRestore();
  }

  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const menu = await import('@rezics/ui/menu');
  const actions = await import('../src/library/pins-actions');
  const { m } = await import('../src/paraglide/messages.js');
  const menus: MenuProps[] = [];
  const OriginalMenu = menu.Menu;
  const menuRead = spyOn(menu, 'Menu').mockImplementation((props) => {
    menus.push(props);
    return OriginalMenu(props);
  });
  const pendingReads: ReturnType<typeof deferred<MineCollectionsViewerPage>>[] = [];
  const transport = spyOn(reads, 'readMineCollectionsViewerPage').mockImplementation(() => {
    const work = deferred<MineCollectionsViewerPage>();
    pendingReads.push(work);
    return work.promise;
  });
  const writes: {
    input: Parameters<typeof actions.pinCollection>[0];
    work: ReturnType<typeof deferred<PinMutation>>;
  }[] = [];
  const write = spyOn(actions, 'pinCollection').mockImplementation((input) => {
    const work = deferred<PinMutation>();
    writes.push({ input, work });
    return work.promise;
  });
  let initial = response('A');
  let search: MineCollectionsSearch = { layout: 'previews' };
  const loader = spyOn(Route, 'useLoaderData').mockImplementation(() => initial);
  const address = spyOn(Route, 'useSearch').mockImplementation(() => search);
  const Page = Route.options.component!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const invalidate = spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const hydrationErrors: unknown[] = [];
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <Page />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const session = (subject: string, csrfToken = `csrf-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
  const show = async (viewer: { state: string; subject?: string; csrfToken: string | null }, admitted = true) => {
    menus.length = 0;
    await act(async () => {
      client.setQueryData(['session'], viewer);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['collections', 'personal_library'] : []);
      client.setQueryData(['exposure', 'anonymous'], []);
      if (!root) {
        const html = renderToString(tree());
        expect(html).toContain('Private A');
        expect(html).toContain('Pinned A');
        host.innerHTML = html;
        root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
      } else root.render(tree());
    });
  };
  const pin = () => {
    const entry = menus
      .flatMap((props) => props.entries ?? [])
      .findLast((entry) => entry.type === 'item' && entry.label === m.library_pin_pin());
    if (!entry || entry.type !== 'item') throw new Error('Missing actual native pin control');
    return entry;
  };
  const settle = async (index: number, value: MineCollectionsViewerPage) => {
    await act(async () => pendingReads[index]!.resolve(value));
    // Query notifications use the installed scheduler.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const refetch = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: ['mine-collections-current-viewer'], type: 'active' });
    });
  };
  const retired = (subject: string) => {
    for (const text of [`Private ${subject}`, `Preview ${subject}`, `Pinned ${subject}`, `Navigation ${subject}`])
      expect(host.textContent).not.toContain(text);
    expect(host.querySelector(`a[href="/en/collections/pin-${subject}"]`)).toBeNull();
    expect([...host.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes(`next-${subject}`))).toBe(
      false,
    );
  };
  try {
    await show(session('A'));
    expect(host.textContent).toContain('Private A');
    expect(host.textContent).toContain('Preview A');
    expect(pendingReads).toHaveLength(1);
    await act(async () => pin().onSelect());
    const oldIntent = writes[0]!.input.data;
    await show(session('B'));
    retired('A');
    expect(host.textContent).toContain(m.library_collections_preparing());
    expect(pendingReads).toHaveLength(2); // B starts while A's read and native write are still pending.
    await settle(1, response('B'));
    expect(host.textContent).toContain('Private B');
    expect(host.textContent).toContain('Preview B');
    expect(pin().disabled).toBe(false);
    await act(async () => pin().onSelect());
    expect(writes[1]!.input.data.idempotencyKey).not.toBe(oldIntent.idempotencyKey);
    await settle(0, response('A'));
    await act(async () => writes[0]!.work.reject(new Error('Retired A write')));
    retired('A');
    expect(pin().disabled).toBe(true);
    expect(host.textContent).not.toContain(m.error_message());
    await show(session('B', 'rotated-nonempty-csrf'));
    expect(pin().disabled).toBe(true);
    initial = response('B'); // An ordinary loader refresh must also keep this native attempt alive.
    await show(session('B', 'rotated-nonempty-csrf'));
    expect(pin().disabled).toBe(true);
    expect(pendingReads).toHaveLength(3);
    await settle(2, response('B'));
    await act(async () => writes[1]!.work.reject(new Error('Uncertain current write')));
    await act(async () => pin().onSelect());
    expect(writes[2]!.input.data).toEqual(writes[1]!.input.data);
    expect(new Headers(writes[2]!.input.headers).get('X-CSRF-Token')).toBe('rotated-nonempty-csrf');
    await act(async () => writes[2]!.work.resolve({ ok: false, reason: 'full' }));

    search = { cursor: 'second+/page==', layout: 'rows' };
    await show(session('B', 'rotated-nonempty-csrf'));
    retired('B');
    expect(pendingReads).toHaveLength(4);
    await settle(3, response('B')); // Matching subject alone cannot authorize the wrong cursor/layout.
    retired('B');
    expect(host.textContent).toContain(m.library_collections_unavailable());
    await refetch();
    await settle(4, response('B', search.cursor!, 'rows'));
    expect(host.textContent).toContain('Private B');
    expect(host.textContent).not.toContain('Preview B');
    await refetch(); // Retire another in-flight read before an ABA return to B.
    await show({ state: 'unavailable', csrfToken: null });
    retired('B');
    expect(host.querySelector('[data-library-pin-manager]')).toBeNull();
    await show(session('B'));
    retired('B');
    expect(pendingReads).toHaveLength(7);
    await settle(5, response('B', search.cursor!, 'rows'));
    retired('B');
    await settle(6, response('B', search.cursor!, 'rows'));
    expect(host.textContent).toContain('Private B');
    await show(session('B'), false);
    retired('B');
    expect(host.textContent).toContain(m.library_collections_denied());
    await show(session('B'));
    retired('B');
    await settle(7, response('A', search.cursor!, 'rows'));
    retired('A');
    retired('B');
    await refetch();
    await settle(8, response('B', search.cursor!, 'rows'));
    expect(host.textContent).toContain('Private B');
    expect(host.textContent).toContain('Pinned B');
    // Entering a malformed saved address retires the active private read before it can settle.
    await refetch();
    search = { layout: 'rows', addressError: { cursor: 'number' } };
    await show(session('B'));
    expect(host.querySelector('[data-collections-state="invalid-address"]')).not.toBeNull();
    retired('B');
    expect(pendingReads).toHaveLength(10);
    await settle(9, response('B', 'old-page', 'rows'));
    retired('B');
    expect(pendingReads).toHaveLength(10);
    expect(hydrationErrors).toEqual([]);
  } finally {
    if (root) await act(async () => root!.unmount());
    client.clear();
    host.remove();
    for (const restore of [menuRead, transport, write, loader, address, invalidate]) restore.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
