import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionFacetRequest } from '../src/library/collection-facet-values';
import { readCollectionFilterParams } from '../src/library/collection-filter-params';
import type { FacetState, RequestedFacet } from '../src/search/refinement/request';
import { refinementProperties } from '../src/search/refinement/model';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://rezics.test/en/search' });
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

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { Refinement } = await import('../src/search/refinement/refinement');
const { collectionFacetRequest } = await import('../src/library/collection-facet-values');
const { setLocale } = await import('../src/paraglide/runtime.js');

test('Collection readers keep exact facet scope, page count-free values, retain selections, and retire late pages', async () => {
  const release = {
    types: { 'fixture:Book': { bases: [], facets: Array.from({ length: 10 }, (_, i) => `fixture:property:${i}`) } },
    properties: Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `fixture:property:${index}`,
        { labels: { en: `Released ${index}` }, datatype: 'wikibase-item', targets: ['fixture:Target'] },
      ]),
    ),
  };
  const properties = refinementProperties(release, 'fixture:Book').filter((entry) => entry.property !== 'type');
  const kept = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  const appliedParams = new URLSearchParams(kept.map((value) => [`f.${properties[0]!.property}`, value]));
  const filter = readCollectionFilterParams(appliedParams, release, 'fixture:Book').document!;
  const beyondWindow = readCollectionFilterParams(
    new URLSearchParams(`f.${properties[9]!.property}=00000000-0000-4000-8000-000000000009`),
    release,
    'fixture:Book',
  );
  expect(beyondWindow.selected[properties[9]!.property]).toEqual(['00000000-0000-4000-8000-000000000009']);
  expect(filter).toEqual({ statement: { property: properties[0]!.property, in: kept } });
  const admitted: FilterDocument = filter;
  const common = { type: 'fixture:Book', release: 'release-7', filter: admitted, languages: ['zh-Hant', 'en'] };
  const reads: CollectionFacetRequest[] = [];
  const pending: { resolve: (state: FacetState) => void }[] = [];
  let outcome: 'ready' | 'refused' | 'unavailable' = 'ready';
  const page = (facet: RequestedFacet, offset: number): FacetState => ({
    status: 'ready',
    page: {
      as_of: new Date(0).toISOString(),
      facets: [{
        property: facet.property,
        values: Array.from({ length: 10 }, (_, index) => ({
          value: `value-${offset + index + 1}`,
          labels: { en: `Value ${offset + index + 1}` },
        })),
        next: offset ? null : 'opaque-next',
      }],
    },
  });
  const contexts = [
    { ...common, resource: { kind: 'collection' as const, id: 'public-curated' } },
    { ...common, resource: { kind: 'collection' as const, id: 'builtin-owner' } },
  ];
  let reader = 0;
  const load = async (facets: RequestedFacet[]) => {
    const request = collectionFacetRequest(contexts[reader]!, facets);
    reads.push(request);
    if (reader === 0)
      return await new Promise<FacetState>((resolve) => pending.push({ resolve }));
    if (outcome !== 'ready') return { status: outcome, code: `collection_${outcome}` };
    return page(facets[0]!, facets[0]!.cursor ? 10 : 0);
  };
  let props: ComponentProps<typeof Refinement> = {
    data: { key: 'curated:anonymous:release-7', properties },
    conditions: { facetValues: { [properties[0]!.property]: kept } },
    query: '',
    locale: 'en',
    perPropertyState: true,
    onConditionsChange: () => {},
    load,
  };
  let refresh: () => void = () => {};
  function Screen() {
    const [, setVersion] = useState(0);
    refresh = () => setVersion((version) => version + 1);
    return <Refinement {...props} />;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    setLocale('en', { reload: false });
    const route = createRootRoute({ component: Screen });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search'] }) });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(host.querySelector('fieldset')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => input.value)).toContain(kept[0]);

    const choose = async (property: string) => {
      const select = host.querySelector<HTMLSelectElement>('select')!;
      await act(async () => {
        select.value = property;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    };
    await choose(properties[9]!.property);
    expect(reads[0]).toEqual({ ...contexts[0], facets: [{ property: properties[9]!.property, size: 10 }] });
    reader = 1;
    props = { ...props, data: { ...props.data, key: 'builtin:owner:release-7' } };
    await act(async () => refresh());
    await choose(properties[8]!.property);
    expect(await host.querySelector('input[value="value-1"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${kept[0]}"]`)?.checked).toBe(true);
    const more = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'More values')!;
    await act(async () => more.click());
    expect(await host.querySelector('input[value="value-20"]')).not.toBeNull();
    expect(reads.slice(1)).toEqual([
      { ...contexts[1], facets: [{ property: properties[8]!.property, size: 10 }] },
      { ...contexts[1], facets: [{ property: properties[8]!.property, size: 10, cursor: 'opaque-next' }] },
    ]);
    pending[0]!.resolve(page({ property: properties[9]!.property }, 0));
    await act(async () => Promise.resolve());
    expect(host.querySelector('input[value="value-1"]')).not.toBeNull();
    outcome = 'refused';
    props = { ...props, data: { ...props.data, key: 'builtin:owner:denied' } };
    await act(async () => refresh());
    await choose(properties[7]!.property);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not available for refinement');
    expect(host.textContent).not.toContain('No values found');
    outcome = 'unavailable';
    props = { ...props, data: { ...props.data, key: 'builtin:owner:unavailable' } };
    await act(async () => refresh());
    await choose(properties[6]!.property);
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Try again')!;
    await act(async () => retry.click());
    expect(reads.slice(-2).every((request) => request.resource.id === 'builtin-owner')).toBe(true);
    expect(reads.every((request) => request.resource.kind === 'collection')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
