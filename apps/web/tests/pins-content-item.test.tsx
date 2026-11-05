import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { LibraryPinsRead } from '../src/library/pins-read';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

// UNRUN: composed actual-UI assertions; native, browser and visual acceptance remain deferred.
test('Pinned Collection items preserve unavailable targets and independent unpin controls', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/zh-Hant/library/collections', width: 1280 });
  window.document.documentElement.lang = 'zh-Hant';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { MineCollectionsPageView } = await import('../src/library/mine-collections-page');
  const actions = await import('../src/library/pins-actions');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('zh-Hant', { reload: false });
  const collectionId = 'reading /?#%';
  const unavailableId = 'unavailable /?#%';
  const pins: LibraryPinsRead = {
    state: 'loaded',
    canRemove: true,
    revision: 7,
    next: null,
    pins: [
      { collectionId, target: { id: collectionId, title: 'Pinned stories' } },
      {
        collectionId: 'state-collection',
        target: { id: 'state-collection', builtinKind: 'state', builtinLabels: { 'zh-Hant': '想讀' } },
      },
      { collectionId: unavailableId, target: null },
    ],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'current-csrf' });
  client.setQueryData(exposureQuery.queryKey, ['personal_library', 'collections']);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/library/collections'] }),
  });
  const invalidate = spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const unpin = spyOn(actions, 'unpinCollection').mockResolvedValue({ ok: true, revision: 8 });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const destinations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor) {
      destinations.push(anchor.getAttribute('href')!);
      event.preventDefault();
    }
  });

  try {
    await router.load();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <MineCollectionsPageView page={{ signedIn: true, collections: [], next: null }} pins={pins} />
          </RouterContextProvider>
        </QueryClientProvider>,
      );
    });
    const manager = host.querySelector('[data-library-pin-manager]')!;
    await act(async () => user.click(manager.querySelector('summary')!));
    const rows = [...manager.querySelectorAll('ul > li')];
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'Pinned stories',
      '想讀',
      m.library_pin_unavailable(),
    ]);
    const heading = rows[0]!.querySelector('h3')!;
    expect(heading.closest('[hidden], [aria-hidden="true"], .sr-only')).toBeNull();
    const primary = rows[0]!.querySelector('a')!;
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    expect([...rows[0]!.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/zh-Hant/collections/reading%20%2F%3F%23%25',
    ]);
    expect(rows[2]!.querySelector('a')).toBeNull();

    const trigger = rows[0]!.querySelector('button')!;
    expect(trigger.closest('[data-slot="list-row-control"]')).not.toBeNull();
    expect(trigger.closest('a')).toBeNull();
    trigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const remove = [...window.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === m.library_pin_unpin(),
    )!;
    await act(async () => user.click(remove));
    await act(async () => user.click(rows[2]!.querySelector('button')!));
    const removeUnavailable = [...window.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === m.library_pin_unpin(),
    )!;
    await act(async () => user.click(removeUnavailable));
    expect(unpin.mock.calls.map(([input]) => [input.data.collectionId, input.data.revision])).toEqual([
      [collectionId, pins.revision],
      [unavailableId, pins.revision],
    ]);
    expect(destinations).toEqual([]);
    expect(router.state.location.href).toBe('/library/collections');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    unpin.mockRestore();
    invalidate.mockRestore();
    host.remove();
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
