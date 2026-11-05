import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useRef, useState } from 'react';
import { type CollectionFacetRequest } from '../src/library/collection-facet-values';
import { type FacetState } from '../src/search/refinement/request';

test('retired Collection and selection review episodes cannot publish, focus, or reopen through ABA', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://site.test/en/collections/collection-a?type=schema%3ABook', width: 1280 });
  browser.document.documentElement.lang = 'en';
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    Element: browser.Element,
    Node: browser.Node,
    NodeFilter: browser.NodeFilter,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    FormData: browser.FormData,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    scrollTo: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { CollectionFilters } = await import('../src/library/collection-filters');
  const { SelectionReviewView } = await import('../src/library/selection-review-view');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const params = { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] };
  const properties = [
    { id: 'schema:keywords', label: 'Concept', datatype: 'wikibase-item', targets: ['skos:Concept'] },
  ];
  const facetLoads: {
    request: CollectionFacetRequest;
    signal: AbortSignal;
    resolve: (state: FacetState) => void;
  }[] = [];
  const facetLoader = (request: CollectionFacetRequest, signal: AbortSignal) =>
    new Promise<FacetState>((resolve) => facetLoads.push({ request, signal, resolve }));
  const visits: string[] = [];
  const originalAssign = browser.location.assign.bind(browser.location);
  Object.defineProperty(browser.location, 'assign', {
    configurable: true,
    value: (address: string) => visits.push(address),
  });
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  client.setQueryData(exposureQuery.queryKey, []);
  let router!: ReturnType<typeof createRouter>;

  function Harness() {
    const [source, setSource] = useState<'A' | 'B'>('A');
    const [reviewOpen, setReviewOpen] = useState(false);
    const [reviewKey, setReviewKey] = useState('selection-A');
    const launcher = useRef<HTMLButtonElement>(null);
    const id = source === 'A' ? 'collection-a' : 'collection-b';
    const changeSource = () => {
      const next = source === 'A' ? 'B' : 'A';
      setSource(next);
      void router.navigate({ href: `/en/collections/collection-${next.toLowerCase()}?type=schema%3ABook` });
    };
    return (
      <>
        <button type="button" onClick={changeSource}>
          Change collection source
        </button>
        <button
          type="button"
          onClick={() => setReviewKey((current) => (current.endsWith('A') ? 'selection-B' : 'selection-A'))}
        >
          Replace selection set
        </button>
        <button type="button" onClick={() => setReviewOpen(false)}>
          End selection review
        </button>
        <button key={reviewKey} ref={launcher} type="button" onClick={() => setReviewOpen(true)}>
          Open selection review {reviewKey}
        </button>
        <CollectionFilters
          id={id}
          type="schema:Book"
          properties={properties}
          params={params}
          filterReleaseKey={`release-${source}`}
          viewerKey={`viewer-${source}`}
          facetLoader={facetLoader}
        />
        <SelectionReviewView
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          items={[{ subjectId: reviewKey, title: reviewKey }]}
          statusChoices={[]}
          statusValue=""
          statusAllowed={false}
          statusBlocked={false}
          pending={false}
          hydrated
          episodeKey={reviewKey}
          onStatusChange={() => undefined}
          onReviewStatus={() => undefined}
          launcher={launcher}
          isCurrent={() => true}
        />
      </>
    );
  }

  const route = createRootRoute({ component: Harness });
  router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/collections/collection-a?type=schema%3ABook'] }),
  });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => browser.setTimeout(resolve, 40));
    });
  const readyFacet = (value: string): FacetState => ({
    status: 'ready',
    page: {
      facets: [{ property: 'schema:keywords', values: [{ value, labels: { en: value } }], next: null }],
      as_of: '2025-01-01T00:00:00Z',
    },
  });
  try {
    await router.load();
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });

    const dialog = () => browser.document.querySelector<HTMLElement>('[role="dialog"]');
    const collectionLauncher = () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.getAttribute('aria-label') === m.collection_filters(),
      )!;
    const sourceButton = () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Change collection source',
      )!;
    const selectionLauncher = () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.startsWith('Open selection review'),
      )!;

    await act(async () => collectionLauncher().click());
    await settle();
    const oldSurface = dialog()!;
    await act(async () =>
      [...oldSurface.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.refinement_load_values())!
        .click(),
    );
    await settle();
    expect(facetLoads).toHaveLength(1);
    expect(facetLoads[0]!.request.resource.id).toBe('collection-a');
    expect(facetLoads[0]!.request.release).toBe('release-A');
    const retiredSubmit = oldSurface.querySelector<HTMLFormElement>('form')!;

    await act(async () => {
      sourceButton().focus();
      sourceButton().click();
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(facetLoads[0]!.signal.aborted).toBe(true);
    expect(browser.document.activeElement).not.toBe(collectionLauncher());
    facetLoads[0]!.resolve(readyFacet('stale-A-choice'));
    await settle();
    await act(async () =>
      retiredSubmit.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(visits).toHaveLength(0);
    expect(host.textContent).not.toContain('stale-A-choice');

    await act(async () => sourceButton().click());
    await settle();
    expect(dialog()).toBeNull();
    await act(async () => collectionLauncher().click());
    await settle();
    const newSurface = dialog()!;
    await act(async () =>
      [...newSurface.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.refinement_load_values())!
        .click(),
    );
    await settle();
    expect(facetLoads).toHaveLength(2);
    expect(facetLoads[1]!.request.resource.id).toBe('collection-a');
    expect(facetLoads[1]!.request.release).toBe('release-A');
    facetLoads[1]!.resolve(readyFacet('fresh-A-choice'));
    await settle();
    expect(newSurface.textContent).toContain('fresh-A-choice');
    expect(newSurface.textContent).not.toContain('stale-A-choice');
    await act(async () =>
      [...newSurface.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.library_collection_cancel())!
        .click(),
    );
    await settle();
    expect(browser.document.activeElement).toBe(collectionLauncher());
    expect(visits).toHaveLength(0);

    await act(async () => selectionLauncher().click());
    await settle();
    expect(dialog()).not.toBeNull();
    const oldSelectionLauncher = selectionLauncher();
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Replace selection set')!
        .click();
    });
    await settle();
    expect(dialog()).toBeNull();
    const newSelectionLauncher = selectionLauncher();
    expect(newSelectionLauncher).not.toBe(oldSelectionLauncher);
    expect(browser.document.activeElement).not.toBe(newSelectionLauncher);

    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Replace selection set')!
        .click(),
    );
    await settle();
    expect(dialog()).toBeNull();
    const abaSelectionLauncher = selectionLauncher();
    expect(abaSelectionLauncher).not.toBe(newSelectionLauncher);
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'End selection review')!
        .click(),
    );
    await settle();
    await act(async () => abaSelectionLauncher.click());
    await settle();
    expect(dialog()).not.toBeNull();
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.library_selection_review_close())!
        .click(),
    );
    await settle();
    expect(browser.document.activeElement).toBe(abaSelectionLauncher);

    await act(async () => collectionLauncher().click());
    await settle();
    await act(async () =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === m.refinement_load_values())!
        .click(),
    );
    await settle();
    expect(facetLoads).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    expect(facetLoads.at(-1)?.signal.aborted).toBe(true);
    client.clear();
    Object.defineProperty(browser.location, 'assign', { configurable: true, value: originalAssign });
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
