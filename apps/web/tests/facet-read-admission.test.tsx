import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import { facetSearchInvalidation } from '../src/search/search-recovery';
import type { FacetState, RequestedFacet } from '../src/search/refinement/request';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
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
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
type Props = ComponentProps<typeof Refinement>;
const properties: Props['data']['properties'] = [
  { property: 'type', labels: {}, mode: 'types', datatype: 'type', units: [] },
  { property: 'schema:genre', labels: { en: 'Genre' }, mode: 'values', datatype: 'wikibase-item', units: [] },
  { property: 'schema:inLanguage', labels: { en: 'Language' }, mode: 'values', datatype: 'wikibase-item', units: [] },
];

function ready(property: string, value: string, next: string | null): FacetState {
  return {
    status: 'ready',
    page: {
      as_of: '2026-01-01T00:00:00.000Z',
      facets: [{ property, values: [{ value, labels: { en: value } }], next }],
    },
  };
}

function makeProps(key: string, initial: FacetState | undefined, load: Props['load']): Props {
  return {
    data: { key, properties, ...(initial ? { initial } : {}) },
    conditions: { facetValues: {} },
    query: 'reading',
    locale: 'en',
    load,
    onNavigate: () => {},
  };
}

function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

async function selectProperty(host: HTMLElement, property: string) {
  const picker = host.querySelector('select');
  expect(picker).toBeDefined();
  await act(async () => {
    picker!.value = property;
    picker!.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

afterAll(() => {
  setLocale('en', { reload: false });
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('mounted picker, load, More and Retry keep scoped 404 and 429 admission', async () => {
  expect(facetSearchInvalidation({ status: 'refused', httpStatus: 404 })).toBeUndefined();
  expect(
    facetSearchInvalidation({ status: 'unavailable', httpStatus: 429, retryAt: Date.now() + 60_000 }),
  ).toBeUndefined();

  const host = document.createElement('main');
  document.body.append(host);
  const reads: RequestedFacet[][] = [];
  let props = makeProps('restart', { status: 'restart', code: 'repeated_facet_continuation' }, async (facets) => {
    reads.push(facets);
    return { status: 'unavailable', code: 'unused' };
  });
  let update!: (next: Props) => void;
  let root: ReturnType<typeof createRoot> | undefined;
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    setLocale('en', { reload: false });
    function View() {
      const [current, setCurrent] = useState(props);
      update = (next) => {
        props = next;
        setCurrent(next);
      };
      return <Refinement {...current} />;
    }
    const route = createRootRoute({ component: View });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search'] }) });
    await router.load();
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));

    await selectProperty(host, 'schema:inLanguage');
    expect(reads).toEqual([]);
    expect(host.querySelector('input[type="search"]')).not.toBeNull();

    await act(async () =>
      update(
        makeProps('load-404', undefined, async (facets) => {
          reads.push(facets);
          return { status: 'refused', httpStatus: 404, code: 'not_found' };
        }),
      ),
    );
    await act(async () => button(host, m.refinement_load_values()).click());
    expect(reads).toEqual([
      [
        { property: 'type', size: 10 },
        { property: 'schema:genre', size: 10 },
        { property: 'schema:inLanguage', size: 10 },
      ],
    ]);
    await selectProperty(host, 'schema:inLanguage');
    expect(reads).toHaveLength(1);

    const deadline = now + 5_000;
    await act(async () =>
      update(
        makeProps('more-429', ready('schema:genre', 'accepted', 'cursor-one'), async (facets) => {
          reads.push(facets);
          return reads.length === 2
            ? { status: 'unavailable', httpStatus: 429, retryAt: deadline, code: 'rate_limited' }
            : ready('schema:genre', 'next-window', 'cursor-two');
        }),
      ),
    );
    await act(async () => button(host, m.refinement_more_values()).click());
    expect(reads.at(-1)).toEqual([{ property: 'schema:genre', size: 10, cursor: 'cursor-one' }]);
    await selectProperty(host, 'schema:inLanguage');
    expect(button(host, m.search_facet_retry()).disabled).toBe(true);
    expect(reads).toHaveLength(2);
    now = deadline + 1;
    await act(async () => update({ ...props }));
    expect(reads).toHaveLength(2);
    await act(async () => button(host, m.search_facet_retry()).click());
    expect(reads.at(-1)).toEqual([{ property: 'schema:genre', size: 10, cursor: 'cursor-one' }]);
    expect(host.textContent).toContain('next-window');
  } finally {
    Date.now = clock;
    if (root) await act(async () => root!.unmount());
    host.remove();
  }
});

test('a replaced owner cannot publish a late facet read', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const reads: string[] = [];
  let finish!: (state: FacetState) => void;
  const pending = new Promise<FacetState>((resolve) => {
    finish = resolve;
  });
  let props = makeProps('retired', undefined, async (facets) => {
    reads.push(facets.map((facet) => facet.property).join(','));
    return pending;
  });
  let update!: (next: Props) => void;
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    setLocale('en', { reload: false });
    function View() {
      const [current, setCurrent] = useState(props);
      update = (next) => {
        props = next;
        setCurrent(next);
      };
      return <Refinement {...current} />;
    }
    const route = createRootRoute({ component: View });
    const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search'] }) });
    await router.load();
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await act(async () => button(host, m.refinement_load_values()).click());
    await act(async () =>
      update(
        makeProps('current', undefined, async (facets) => {
          reads.push(`current:${facets.map((facet) => facet.property).join(',')}`);
          return ready('schema:genre', 'current-window', null);
        }),
      ),
    );
    await act(async () => {
      finish(ready('schema:genre', 'retired-window', null));
      await pending;
    });
    expect(host.textContent).not.toContain('retired-window');
    await act(async () => button(host, m.refinement_load_values()).click());
    expect(reads).toEqual(['type,schema:genre,schema:inLanguage', 'current:type,schema:genre,schema:inLanguage']);
    expect(host.textContent).toContain('current-window');
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
  }
});
