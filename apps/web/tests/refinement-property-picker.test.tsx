import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import type { RequestedFacet } from '../src/search/refinement/request';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://search.test/en/search' });
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
const { setLocale } = await import('../src/paraglide/runtime.js');

test('finds and selects a roster property locally by name or exact ID while preserving constraints', async () => {
  const properties = Array.from({ length: 10 }, (_, index) => ({
    property: `fixture:property:${index}`,
    labels: { en: index > 7 ? 'Shared name' : `Property ${index}` },
    mode: 'values' as const,
    datatype: 'string',
    units: [],
  }));
  const reads: RequestedFacet[][] = [];
  const navigations: string[] = [];
  const props = {
    data: {
      key: 'property-picker',
      properties,
    },
    conditions: {
      facetValues: {
        [properties[0]!.property]: ['value-0'],
        [properties[7]!.property]: ['value-7'],
      },
    },
    query: 'reading',
    locale: 'en',
    load: async (facets) => {
      reads.push(facets);
      return { status: 'unavailable', code: 'fixture' };
    },
    onNavigate: (href: string) => navigations.push(href),
  } satisfies ComponentProps<typeof Refinement>;
  const host = document.createElement('main');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    setLocale('en', { reload: false });
    const route = createRootRoute({ component: () => <Refinement {...props} /> });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search'] }) });
    await router.load();
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const type = async (value: string) =>
      act(async () => {
        setter.call(search, value);
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await type('not on the roster');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('No matching properties.');
    expect(reads).toHaveLength(0);
    await type('shared');
    const select = host.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].filter((option) => option.value).map((option) => option.textContent)).toEqual([
      'Shared name (fixture:property:8)',
      'Shared name (fixture:property:9)',
    ]);
    await type(properties[8]!.property);
    expect([...select.options].filter((option) => option.value).map((option) => option.value)).toEqual([
      properties[8]!.property,
    ]);
    expect(reads).toHaveLength(0);
    await act(async () => {
      select.value = properties[8]!.property;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

    expect(reads).toEqual([[{ property: properties[8]!.property, size: 10 }]]);
    expect(navigations).toEqual([]);
    expect([...host.querySelectorAll('fieldset')]).toHaveLength(8);
    expect(host.querySelector(`input[type="hidden"][name="f.${properties[0]!.property}"][value="value-0"]`)).not.toBeNull();
    expect(host.querySelector(`input[type="hidden"][name="f.${properties[7]!.property}"][value="value-7"]`)).not.toBeNull();
    expect([...select.options].filter((option) => option.value)).toHaveLength(10);
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
