import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { shelfDisplay, shelfSort, validateShelfSearch } from '../src/library/shelf-params';
import type { PersonalLibraryView } from '../src/library/entries-read';
import { m } from '../src/paraglide/messages.js';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonalLibraryPage } = await import('../src/library/entries-page');
afterAll(() => mock.restore());
const initial = {
  type: 'schema:Book',
  state: 'planned',
  cursor: 'page:2',
  orderBy: 'createdAt',
  direction: 'asc',
  layout: 'grid',
  size: 'l',
  columns: 'title',
} as const;

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'reading_progress']);
  let response: Partial<Extract<PersonalLibraryView, { signedIn: true }>> = {};
  const root = createRootRoute();
  const library = createRoute({
    getParentRoute: () => root,
    path: '/library',
    validateSearch: validateShelfSearch,
    loader: () => response,
    component: () => {
      const search = library.useSearch();
      return (
        <PersonalLibraryPage
          page={{
            signedIn: true,
            entries: [],
            next: null,
            ...search,
            sort: shelfSort(search),
            sortExplicit: true,
            ...library.useLoaderData(),
          }}
          cursor={search.cursor}
          locale="en"
          display={shelfDisplay(search)}
          acceptedNavigation={{ pins: { state: 'closed' }, collections: [], collectionsState: 'loaded' }}
          continueState={{ state: 'loaded', entries: [], next: null }}
        />
      );
    },
  });
  const subject = createRoute({ getParentRoute: () => root, path: '/subjects/item', component: () => <p>Item</p> });
  const router = createRouter({
    routeTree: root.addChildren([library, subject]),
    history: createMemoryHistory({ initialEntries: [`/library?${new URLSearchParams(initial)}`] }),
  });
  return {
    client,
    router,
    element: (
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    ),
    respond: (value: typeof response) => {
      response = value;
      return router.invalidate();
    },
  };
}

function query(href: string) {
  return Object.fromEntries(new URL(href, 'https://site.test').searchParams);
}

test('GET controls, page-local emptiness and failed reads retain the selected first-page meaning', async () => {
  const f = fixture();
  await f.router.load();
  try {
    const html = () => renderToStaticMarkup(f.element).replaceAll('&amp;', '&');
    const later = html();
    expect(later).toContain(m.library_entries_page_empty());
    expect(later).not.toContain(m.library_empty_title());
    expect(later).toMatch(/<form[^>]*action="\/en\/library"[^>]*method="get"/);
    expect(later).toContain('name="type" value="schema:Book"');
    expect(later).toContain('name="state" value="planned"');
    expect(later).toContain('name="columns" value="title"');
    expect(later).not.toContain('name="cursor"');
    expect(later).toContain('value="createdAt" selected=""');
    const hrefs = [...later.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
    const list = hrefs.find((href) => query(href).layout === 'list')!;
    expect(query(list)).toEqual({ ...initial, layout: 'list' });
    const clearState = hrefs.find((href) => query(href).type && !query(href).state)!;
    expect(query(clearState)).toEqual({
      type: initial.type,
      orderBy: initial.orderBy,
      direction: initial.direction,
      size: initial.size,
      columns: initial.columns,
    });
    await f.respond({ readState: 'unavailable' });
    const failed = html();
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain(m.library_entries_page_empty());
    const recovery = [...failed.matchAll(/href="([^"]+)"[^>]*>\s*First page/g)][0]![1]!;
    expect(query(recovery)).toEqual({
      type: initial.type,
      state: initial.state,
      orderBy: initial.orderBy,
      direction: initial.direction,
      size: initial.size,
      columns: initial.columns,
    });
    await f.respond({ cursorReset: true });
    expect(html()).toContain(m.library_sort_restarted());
    expect(html()).not.toContain(m.library_entries_page_empty());
  } finally {
    f.client.clear();
  }
});

test('sort and display navigate complete queries; history restores the controls and expired cursors stay retired', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/library' });
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
    FormData: window.FormData,
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const exposure = spyOn(await import('../src/kernel/viewer-exposure'), 'readViewerExposure').mockResolvedValue({
    subject: 'owner',
    admitted: ['personal_library', 'reading_progress'],
  });
  const f = fixture();
  await f.router.load();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const run = async (work: () => unknown) =>
    act(async () => {
      await work();
      await new Promise((done) => setTimeout(done, 0));
    });
  const select = (name: string) => host.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
  const chooseLayout = (value: string) => {
    const control = host.querySelector<HTMLSelectElement>('[data-slot="layout-select"]')!;
    control.value = value;
    control.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const search = () => validateShelfSearch(f.router.state.location.search);
  try {
    await run(() => root.render(f.element));
    await run(() => chooseLayout('list'));
    expect(search()).toEqual({ ...initial, layout: 'list' });
    select('orderBy').value = 'finishedAt';
    select('direction').value = 'desc';
    const form = host.querySelector('form[method="get"]')!;
    const nativeQuery = validateShelfSearch(Object.fromEntries(new window.FormData(form as never)));
    await run(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(search()).toEqual(nativeQuery);
    expect(search()).not.toHaveProperty('cursor');
    await run(() => f.router.history.back());
    expect(search()).toEqual({ ...initial, layout: 'list' });
    expect(select('orderBy').value).toBe('createdAt');
    expect(select('direction').value).toBe('asc');
    await run(() => f.router.history.forward());
    expect(select('orderBy').value).toBe('finishedAt');
    await run(() => f.router.navigate({ to: '/subjects/item' }));
    await run(() => f.router.history.back());
    expect(search()).toEqual(nativeQuery);
    expect(select('orderBy').value).toBe('finishedAt');
    await run(() => f.router.history.back());
    await run(() => f.respond({ cursorReset: true }));
    await run(() => chooseLayout('grid'));
    expect(search()).not.toHaveProperty('cursor');
    expect(search().state).toBe('planned');
    expect(search().type).toBe(initial.type);
  } finally {
    await act(async () => root.unmount());
    exposure.mockRestore();
    f.client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
