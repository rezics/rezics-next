import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { readCollectionFilterParams } from '../src/library/collection-filter-params';
import type { EditableCollectionPage } from '../src/library/collection-load';
import collection from '../src/kernel/recorded/library-collection.json';
import { collectionStoryMembers } from '../src/kernel/fake/collection-stories';

test('Collection filters open a correctly sized dialog or phone sheet and apply without losing member context', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/collections/' + collection.collection.id });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
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
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { CollectionPage } = await import('../src/library/collection-page');
  const { libraryNavigationQuery } = await import('../src/library/pins-read');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const concept = '00000000-0000-4000-8000-000000000123';
  const otherConcept = '00000000-0000-4000-8000-000000000124';
  const properties = [
    {
      id: 'schema:keywords',
      label: 'Catalogue concepts associated with the complete work and every published volume',
      datatype: 'wikibase-item',
      targets: ['skos:Concept'],
    },
    { id: 'schema:wordCount', label: 'Word count across every published volume', datatype: 'quantity', unit: '1' },
  ];
  const release = {
    types: { 'schema:Book': { bases: [], facets: properties.map((property) => property.id) } },
    properties: Object.fromEntries(properties.map((property) => [property.id, { ...property, units: ['1'] }])),
  };
  const applied = new URLSearchParams({
    type: 'schema:Book',
    layout: 'grid',
    cursor: 'previous-query-page',
    'l.schema:keywords': 'A long supplied concept label that remains readable in the filter editor',
    'r.schema:wordCount': '1000001,999999999999999',
  });
  applied.append('f.schema:keywords', concept);
  applied.append('f.schema:keywords', otherConcept);
  const params = readCollectionFilterParams(applied, release, 'schema:Book');
  const page: EditableCollectionPage = {
    ...collection.collection,
    visibility: null,
    disclosedVisibility: 'public',
    members: collectionStoryMembers,
    next: null,
    memberCount: collectionStoryMembers.length,
    memberState: 'ready',
    firstPage: true,
    following: null,
    publicExport: false,
    filterType: 'schema:Book',
    filterProperties: properties,
    filterParams: params,
    filter: params.document!,
  };
  const originalFetch = globalThis.fetch;
  const lookups: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), window.location.href);
    expect(url.pathname).toBe('/api/search/suggestions');
    lookups.push(url.searchParams.get('q')!);
    return Response.json({
      subjects: [{ id: concept, type: 'skos:Concept', labels: { en: params.selectedLabels['schema:keywords'] } }],
      types: { 'skos:Concept': { en: 'Concept' } },
    });
  }) as typeof fetch;
  const visits: URL[] = [];
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    value: (href: string) => visits.push(new URL(href, window.location.href)),
  });
  const document = window.document;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false } },
  });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  client.setQueryData(exposureQuery.queryKey, []);
  client.setQueryData(libraryNavigationQuery('en', 100).queryKey, { pins: { state: 'closed' }, collections: [] });
  const route = createRootRoute({
    component: () =>
      createElement(CollectionPage, {
        page,
        queryKey: ['collection-page', page.id],
        refreshPage: async () => page,
        cursor: undefined,
        layout: 'grid',
      }),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: [`/en/collections/${page.id}?${applied}`] }),
  });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
  try {
    await router.load();
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
    const members = [...host.querySelectorAll('[data-slot="collection-member-card"]')];
    expect(members).toHaveLength(page.members.length);
    const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.collection_filters()}"]`)!;
    const surface = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const button = (label: string) =>
      [...surface().querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => element.textContent?.trim() === label,
      )!;
    const lowerBound = () => surface().querySelector<HTMLInputElement>('[name="range.from.schema:wordCount"]')!;
    const edit = async () => {
      await act(async () => {
        const input = lowerBound();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '2000001');
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    for (const width of [1280, 390]) {
      const visitsBefore = visits.length;
      window.happyDOM.setWindowSize({ width, height: 900 });
      await settle();
      await act(async () => {
        trigger.focus();
        trigger.click();
      });
      await settle();
      expect(surface()).not.toBeNull();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(surface().querySelector('form')).not.toBeNull();
      expect(surface().querySelector('[data-slot="drawer-swipe-handle"]') !== null).toBe(width === 390);
      expect(lowerBound().value).toBe('1000001');
      const additional = surface().querySelector<HTMLInputElement>(`input[type="checkbox"][value="${otherConcept}"]`)!;
      expect(additional.checked).toBe(true);
      expect(additional.closest('label')?.textContent).toContain(otherConcept);
      expect(surface().contains(document.activeElement)).toBe(true);
      await edit();
      expect(visits).toHaveLength(visitsBefore);
      await act(async () => {
        button(width === 390 ? 'Done' : m.library_collection_cancel()).click();
      });
      await settle();
      expect(document.activeElement).toBe(trigger);
      await act(async () => {
        trigger.click();
      });
      await settle();
      expect(lowerBound().value).toBe('1000001');
      await edit();
      if (width === 390)
        await act(async () => {
          surface().querySelector<HTMLInputElement>(`input[type="checkbox"][value="${otherConcept}"]`)!.click();
        });
      const reset = surface().querySelector<HTMLAnchorElement>('a')!;
      expect(reset.textContent).toBe(m.collection_filter_clear());
      expect(new URL(reset.href).search).toBe('?layout=grid&type=schema%3ABook');
      await act(async () => {
        button(m.collection_filter_apply()).click();
      });
      const next = visits.at(-1)!;
      expect(next.pathname).toBe(`/en/collections/${page.id}`);
      expect(next.searchParams.get('type')).toBe('schema:Book');
      expect(next.searchParams.get('layout')).toBe('grid');
      expect(next.searchParams.has('cursor')).toBe(false);
      expect(next.searchParams.getAll('f.schema:keywords')).toEqual(
        width === 390 ? [concept] : [concept, otherConcept],
      );
      expect(next.searchParams.get('l.schema:keywords')).toBe(params.selectedLabels['schema:keywords']);
      expect(next.searchParams.get('r.schema:wordCount')).toBe('2000001,999999999999999');
      await settle();
      await act(async () => {
        trigger.click();
      });
      await settle();
      const clear = surface().querySelector<HTMLAnchorElement>('a')!;
      clear.addEventListener(
        'click',
        (event) => {
          event.preventDefault();
          visits.push(new URL(clear.href));
        },
        { once: true },
      );
      await act(async () => {
        clear.click();
      });
      const cleared = visits.at(-1)!;
      expect(cleared.pathname).toBe(next.pathname);
      expect(cleared.search).toBe('?layout=grid&type=schema%3ABook');
      expect(readCollectionFilterParams(cleared.searchParams, release, 'schema:Book').document).toBeUndefined();
      await act(async () => {
        button(width === 390 ? 'Done' : m.library_collection_cancel()).click();
      });
      await settle();
      expect([...host.querySelectorAll('[data-slot="collection-member-card"]')]).toEqual(members);
      expect(page.members).toBe(collectionStoryMembers);
    }
    expect(lookups).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    await window.happyDOM.close();
    for (const key of Object.keys(globals)) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
