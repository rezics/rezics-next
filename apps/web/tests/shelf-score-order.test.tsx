import { selectTrigger, selectValue, selectOptions, chooseSelect } from './support/select';
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { shelfHref, validateShelfSearch } from '../src/library/shelf-params';
import type { ComponentProps } from 'react';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { readEntryPage } = await import('../src/library/entries-read');
const { ShelfScoreUnavailable } = await import('../src/library/shelf-view');
const { SortControls } = await import('../src/library/entries-current');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { resolveShelfPresentation, unsupportedShelfSorts, shelfOrderFromLibrary } =
  await import('../src/library/shelf-preferences');

test('saved score intent survives both directions, per-state defaults and explicit address replacement', () => {
  const saved = {
    sorts: { all: { field: 'rating', direction: 'asc' } },
    layouts: { all: 'list' },
    gridSize: 'large',
  } as const;
  expect(unsupportedShelfSorts(saved)).toEqual([]);
  expect(resolveShelfPresentation({}, saved).sort).toEqual({ orderBy: 'personalScore', direction: 'asc' });
  for (const direction of ['asc', 'desc'] as const) {
    for (const state of [undefined, 'in_progress', 'planned', 'completed', 'paused', 'dropped']) {
      const tab = state ?? 'all';
      const defaults = { ...saved, sorts: { [tab]: { field: 'rating' as const, direction } } };
      const filter = state ? { state } : {};
      const implicit = resolveShelfPresentation({ ...filter, type: 'schema:Book', cursor: 'date-cursor' }, defaults);
      expect(implicit.sort).toEqual({ orderBy: 'personalScore', direction });
      expect(implicit.search).toMatchObject({ ...filter, type: 'schema:Book' });
      expect(implicit.search.cursor).toBeUndefined();
      expect(implicit.cursorInvalidated).toBe(true);
      expect(implicit.display).toMatchObject({ layout: 'list', size: 'l' });
      const override = { ...implicit.search, orderBy: 'createdAt' as const, direction, cursor: 'date-cursor' };
      expect(resolveShelfPresentation(override, defaults).search).toEqual(override);
      expect(resolveShelfPresentation(filter, defaults).sort).toEqual(implicit.sort);
    }
    const search = validateShelfSearch({
      type: 'schema:Book',
      state: 'reading.arc-1',
      orderBy: 'personalScore',
      direction,
      cursor: 'opaque:+/next?x',
      layout: 'table',
      columns: 'title,status',
    });
    const resolved = resolveShelfPresentation(search, saved);
    expect(resolved.sort).toEqual({ orderBy: 'personalScore', direction });
    expect(resolved.search.cursor).toBe(search.cursor);
    const address = new URL(shelfHref('en', search), 'https://site.test');
    expect(validateShelfSearch(Object.fromEntries(address.searchParams))).toEqual(search);
    expect(shelfOrderFromLibrary(resolved.sort)).toEqual({ field: 'rating', direction });
  }
});

test('mounted sort form retains score addresses until date selection and replaces pending edits with its address', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library?cursor=obsolete' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    Document: window.Document,
    NodeFilter: window.NodeFilter,
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
    Element: window.Element,
    FormData: window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createMemoryHistory, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
  const lifetime = viewerExposureLifetime(client);
  const releaseExposure = lifetime.subscribe(() => {});
  const admitViewer = (subject: string) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Viewer observation was not enrolled');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject,
      admitted: ['personal_library', 'reading_progress'],
    });
  };
  admitViewer('A');
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library?cursor=obsolete'] }),
  });
  await router.load();
  const navigate = spyOn(router, 'navigate').mockResolvedValue(undefined);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (direction: 'asc' | 'desc', field: 'added' | 'rating' = 'rating') => {
    const props: ComponentProps<typeof SortControls> = {
      locale: 'en',
      state: 'completed',
      type: 'schema:Book',
      display: {
        layout: 'table',
        size: 'l',
        columns: 'title,status',
        layoutExplicit: true,
        sizeExplicit: true,
        columnsExplicit: true,
      },
      sort: resolveShelfPresentation({}, { sorts: { all: { field, direction } } }).sort,
      isCurrent: () => client.getQueryData<{ subject: string }>(['session'])?.subject === 'A',
    };
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, {
          client,
          children: createElement(RouterContextProvider, { router, children: createElement(SortControls, props) }),
        }),
      ),
    );
  };
  const form = () => host.querySelector('form')!;
  const submitted = () => Object.fromEntries(new window.FormData(form()));
  const select = (name: string) => selectTrigger(host, name === 'orderBy' ? 0 : 1);
  const choose = async (name: string, value: string) => {
    await chooseSelect(select(name), value);
  };
  const submit = async () => {
    await act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  };
  const navigation = () => {
    const target = navigate.mock.calls.at(-1)?.[0];
    if (!target || typeof target.search !== 'function') throw new Error('Expected a shelf address replacement');
    return { to: target.to, search: target.search({ cursor: 'obsolete' }) };
  };
  const retained = { state: 'completed', type: 'schema:Book', layout: 'table', size: 'l', columns: 'title,status' };
  try {
    for (const direction of ['asc', 'desc'] as const) {
      await render(direction);
      const order = select('orderBy');
      order.focus();
      expect(selectValue(order)).toBe('personalScore');
      expect(
        (await selectOptions(order))
          .find((item) => item.dataset.value === 'personalScore')
          ?.hasAttribute('data-disabled'),
      ).toBe(false);
      expect(select('direction').disabled).toBe(false);
      expect(submitted()).toEqual({ ...retained, orderBy: 'personalScore', direction });
      expect(new window.FormData(form()).getAll('orderBy')).toEqual(['personalScore']);
      await submit();
      expect(navigation()).toEqual({
        to: '/library',
        search: { ...retained, orderBy: 'personalScore', direction },
      });
      await choose('orderBy', 'createdAt');
      expect(window.document.activeElement).toBe(order);
      expect(select('direction').disabled).toBe(false);
      const changedDirection = direction === 'asc' ? 'desc' : 'asc';
      await choose('direction', changedDirection);
      expect(submitted()).toEqual({ ...retained, orderBy: 'createdAt', direction: changedDirection });
      await submit();
      expect(navigation()).toEqual({
        to: '/library',
        search: { ...retained, orderBy: 'createdAt', direction: changedDirection },
      });
      // Back/Forward replaces the address without remounting the form or losing its focused control.
      await render(changedDirection);
      expect(window.document.activeElement).toBe(order);
      expect(selectValue(order)).toBe('personalScore');
      expect(selectValue(select('direction'))).toBe(changedDirection);
      expect(submitted()).toEqual({ ...retained, orderBy: 'personalScore', direction: changedDirection });
      await act(async () => {
        client.setQueryData(['session'], { state: 'signed-in', subject: 'B', csrfToken: 'csrf-B' });
        admitViewer('B');
      });
      const before = submitted();
      const calls = navigate.mock.calls.length;
      await choose('orderBy', 'finishedAt');
      await submit();
      expect(navigate).toHaveBeenCalledTimes(calls);
      expect(submitted()).toEqual(before);
      await act(async () => {
        client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
        admitViewer('A');
      });
      // Leave a pending edit for the next address replacement.
      await render(direction);
      await choose('orderBy', 'lastActivity');
    }
    await render('asc', 'added');
    const order = select('orderBy');
    expect(selectValue(order)).toBe('createdAt');
    await choose('orderBy', 'priority');
    expect(
      (await selectOptions(order)).find((item) => item.dataset.value === 'priority')?.hasAttribute('data-disabled'),
    ).toBe(false);
    await choose('direction', 'desc');
    expect(submitted()).toEqual({ ...retained, orderBy: 'priority', direction: 'desc' });
    await submit();
    expect(navigation()).toEqual({
      to: '/library',
      search: { ...retained, orderBy: 'priority', direction: 'desc' },
    });
  } finally {
    await act(async () => root.unmount());
    navigate.mockRestore();
    releaseExposure();
    client.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('score order requests one native FULL page and maps preparation versus currentness', async () => {
  const fetch = mock(() => {
    return Promise.resolve(
      Response.json({
        libraryEntries: [
          { subjectId: 'z', personalScore: 0 },
          { subjectId: 'a', personalScore: null },
        ],
        next: 'native:score-next',
        scoreQuestion: {
          id: '00000000-0000-7000-8000-000000000001',
          meaning: 'Score',
          revision: 1,
          grain: 'count',
          minimumUnits: 0,
          maximumUnits: 20,
          stepUnits: 1,
          lifecycleState: 'active',
          lifecycleRevision: 1,
        },
      }),
    );
  });
  const client = createKernelClient('https://api.test', { fetch });
  const page = await readEntryPage(
    client,
    'Bearer owner',
    undefined,
    'completed',
    20,
    { orderBy: 'personalScore', direction: 'asc' },
    'schema:Book',
  );
  const requested = new URL(String(fetch.mock.calls[0]![0]));
  expect(Object.fromEntries(requested.searchParams)).toMatchObject({
    orderBy: 'personalScore',
    direction: 'asc',
    state: 'completed',
    type: 'schema:Book',
  });
  expect(page.libraryEntries.map((row) => [row.subjectId, row.personalScore])).toEqual([
    ['z', 0],
    ['a', null],
  ]);
  expect(page.scoreQuestion?.id).toBe('00000000-0000-7000-8000-000000000001');
  expect(page.next).toBe('native:score-next');
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        type: 'https://rezics.com/problems/dependency_unavailable',
        code: 'dependency_unavailable',
        detail: 'personalScore: POST /v1/libraryShelfScorePreparation until ready=true',
      },
      { status: 503 },
    ),
  );
  await expect(
    readEntryPage(client, 'Bearer owner', undefined, undefined, 20, { orderBy: 'personalScore', direction: 'desc' }),
  ).rejects.toMatchObject({ state: 'preparing' });
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        type: 'https://rezics.com/problems/dependency_unavailable',
        code: 'dependency_unavailable',
        detail: 'Content native owner-wide score identity fence is not installed',
      },
      { status: 503 },
    ),
  );
  await expect(
    readEntryPage(client, 'Bearer owner', undefined, undefined, 20, { orderBy: 'personalScore', direction: 'asc' }),
  ).rejects.toMatchObject({ state: 'score-unavailable' });
});

test('mounted unavailable recovery retains display and filters, retires the cursor, and keeps keyboard focus', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    Document: window.Document,
    NodeFilter: window.NodeFilter,
    Node: window.Node,
    Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    for (const layout of ['grid', 'list', 'table'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const view = {
          type: 'schema:Book',
          state: 'completed',
          orderBy: 'personalScore',
          direction,
          layout,
          size: 'l',
          columns: 'title,status',
          cursor: 'obsolete',
        } as const;
        await act(async () => root.render(createElement(ShelfScoreUnavailable, { locale: 'en', view })));
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('not current');
        expect(host.querySelector('[data-shelf-score-state]')?.getAttribute('data-shelf-score-state')).toBe(
          'unavailable',
        );
        const [restart, date] = [...host.querySelectorAll('a')];
        const restartSearch = validateShelfSearch(Object.fromEntries(new URL(restart!.href).searchParams));
        expect(restartSearch).toMatchObject({
          type: view.type,
          state: view.state,
          orderBy: view.orderBy,
          direction: view.direction,
          size: view.size,
          columns: view.columns,
        });
        expect(restartSearch.cursor).toBeUndefined();
        expect(restartSearch.layout).toBe(layout === 'grid' ? undefined : layout);
        const dateSearch = validateShelfSearch(Object.fromEntries(new URL(date!.href).searchParams));
        expect(dateSearch).toMatchObject({
          type: view.type,
          state: view.state,
          size: view.size,
          columns: view.columns,
          orderBy: 'finishedAt',
        });
        expect(dateSearch.layout).toBe(layout === 'grid' ? undefined : layout);
        expect(dateSearch.cursor).toBeUndefined();
        restart!.focus();
        await act(async () =>
          root.render(
            createElement(ShelfScoreUnavailable, {
              locale: 'en',
              view: { ...view, direction: direction === 'asc' ? 'desc' : 'asc' },
            }),
          ),
        );
        expect(window.document.activeElement).toBe(restart!);
        expect(host.textContent).not.toContain('No matches');
      }
    }
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
