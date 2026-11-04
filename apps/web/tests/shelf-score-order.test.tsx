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
const { resolveShelfPresentation, unsupportedShelfSorts, shelfOrderFromLibrary } =
  await import('../src/library/shelf-preferences');

test('saved score intent survives both directions, per-state defaults and explicit address replacement', () => {
  const saved = {
    sorts: { all: { field: 'rating', direction: 'asc' } },
    layouts: { all: 'list' },
    gridSize: 'large',
  } as const;
  expect(unsupportedShelfSorts(saved)).toEqual([{ tab: 'all', field: 'rating' }]);
  expect(resolveShelfPresentation({}, saved).sort).toEqual({ orderBy: 'personalScore', direction: 'asc' });
  for (const direction of ['asc', 'desc'] as const) {
    for (const state of [undefined, 'in_progress', 'planned', 'completed', 'paused', 'dropped']) {
      const tab = state ?? 'all';
      const defaults = { ...saved, sorts: { [tab]: { field: 'rating' as const, direction } } };
      const implicit = resolveShelfPresentation({ state, type: 'schema:Book', cursor: 'date-cursor' }, defaults);
      expect(implicit.sort).toEqual({ orderBy: 'personalScore', direction });
      expect(implicit.search).toMatchObject({ state, type: 'schema:Book', cursor: undefined });
      expect(implicit.cursorInvalidated).toBe(true);
      expect(implicit.display).toMatchObject({ layout: 'list', size: 'l' });
      const override = { ...implicit.search, orderBy: 'createdAt' as const, direction, cursor: 'date-cursor' };
      expect(resolveShelfPresentation(override, defaults).search).toEqual(override);
      expect(resolveShelfPresentation({ state }, defaults).sort).toEqual(implicit.sort);
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
  client.setQueryData(['exposure', 'viewer'], ['personal_library', 'reading_progress']);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library?cursor=obsolete'] }),
  });
  await router.load();
  const navigate = spyOn(router, 'navigate').mockResolvedValue(undefined);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (direction: 'asc' | 'desc') => {
    const props: ComponentProps<typeof SortControls> = {
      locale: 'en',
      state: 'completed',
      type: 'schema:Book',
      display: { layout: 'table', size: 'l', columns: 'title,status' },
      sort: resolveShelfPresentation({}, { sorts: { all: { field: 'rating', direction } } }).sort,
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
  const select = (name: string) => host.querySelectorAll('select')[name === 'orderBy' ? 0 : 1]! as HTMLSelectElement;
  const choose = async (name: string, value: string) => {
    await act(async () => {
      select(name).value = value;
      select(name).dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  };
  const retained = { state: 'completed', type: 'schema:Book', layout: 'table', size: 'l', columns: 'title,status' };
  try {
    for (const direction of ['asc', 'desc'] as const) {
      await render(direction);
      const order = select('orderBy');
      order.focus();
      expect(order.value).toBe('personalScore');
      expect(order.querySelector('option[value="personalScore"]')?.hasAttribute('disabled')).toBe(true);
      expect(select('direction').disabled).toBe(true);
      expect(submitted()).toEqual({ ...retained, orderBy: 'personalScore', direction });
      expect(new window.FormData(form()).getAll('orderBy')).toEqual(['personalScore']);
      await submit();
      expect(navigate.mock.calls.at(-1)?.[0]).toEqual({
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
      expect(navigate.mock.calls.at(-1)?.[0]).toEqual({
        to: '/library',
        search: { ...retained, orderBy: 'createdAt', direction: changedDirection },
      });
      // Back/Forward replaces the address without remounting the form or losing its focused control.
      await render(changedDirection);
      expect(window.document.activeElement).toBe(order);
      expect(order.value).toBe('personalScore');
      expect(select('direction').value).toBe(changedDirection);
      expect(submitted()).toEqual({ ...retained, orderBy: 'personalScore', direction: changedDirection });
      await act(async () => {
        client.setQueryData(['session'], { state: 'signed-in', subject: 'B', csrfToken: 'csrf-B' });
      });
      const before = submitted();
      const calls = navigate.mock.calls.length;
      await choose('orderBy', 'finishedAt');
      await submit();
      expect(navigate).toHaveBeenCalledTimes(calls);
      expect(submitted()).toEqual(before);
      await act(async () => {
        client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
      });
      // Leave a pending edit for the next address replacement.
      await render(direction);
      await choose('orderBy', 'lastActivity');
    }
  } finally {
    await act(async () => root.unmount());
    navigate.mockRestore();
    client.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('missing generated score producer rejects both directions before any shelf or per-row vote request', async () => {
  const fetch = mock(() => Promise.resolve(Response.json({ libraryEntries: [], next: null })));
  const client = createKernelClient('https://api.test', { fetch });
  for (const limit of [1, 10, 20]) {
    for (const direction of ['asc', 'desc'] as const) {
      await expect(
        readEntryPage(
          client,
          'Bearer owner',
          'obsolete',
          'completed',
          limit,
          { orderBy: 'personalScore', direction },
          'schema:Book',
        ),
      ).rejects.toMatchObject({ state: 'score-unavailable' });
    }
  }
  expect(fetch).not.toHaveBeenCalled();
  // Chronological reads still use one supplied page and its opaque continuation without local ordering.
  fetch.mockResolvedValueOnce(
    Response.json({ libraryEntries: [{ subjectId: 'z' }, { subjectId: 'a' }], next: 'native:next' }),
  );
  const page = await readEntryPage(client, 'Bearer owner', undefined, undefined, 20, {
    orderBy: 'lastActivity',
    direction: 'desc',
  });
  expect(page.libraryEntries.map((row) => row.subjectId)).toEqual(['z', 'a']);
  expect(page.next).toBe('native:next');
  expect(fetch).toHaveBeenCalledTimes(1);
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
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('not available');
        expect(host.querySelector('[data-shelf-score-state]')?.getAttribute('data-shelf-score-state')).toBe(
          'unavailable',
        );
        const [restart, date] = [...host.querySelectorAll('a')];
        const restartSearch = validateShelfSearch(Object.fromEntries(new URL(restart!.href).searchParams));
        expect(restartSearch).toEqual({ ...view, cursor: undefined });
        const dateSearch = validateShelfSearch(Object.fromEntries(new URL(date!.href).searchParams));
        expect(dateSearch).toMatchObject({
          type: view.type,
          state: view.state,
          layout,
          size: view.size,
          columns: view.columns,
          orderBy: 'finishedAt',
        });
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
