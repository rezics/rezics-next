import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { shelfHref, shelfSort, validateShelfSearch } from '../src/library/shelf-params';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { readEntryPage } = await import('../src/library/entries-read');
const { ShelfScoreUnavailable } = await import('../src/library/shelf-view');
const { resolveShelfPresentation, unsupportedShelfSorts, shelfOrderFromLibrary } =
  await import('../src/library/shelf-preferences');

test('score addresses survive reload while unsupported saved scores never select a native order', () => {
  const saved = {
    sorts: { all: { field: 'rating', direction: 'asc' } },
    layouts: { all: 'list' },
    gridSize: 'large',
  } as const;
  expect(unsupportedShelfSorts(saved)).toEqual([{ tab: 'all', field: 'rating' }]);
  expect(resolveShelfPresentation({}, saved).sort).toEqual(shelfSort({}));
  for (const direction of ['asc', 'desc'] as const) {
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
