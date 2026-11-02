import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import { MAX_CACHED_FACET_PROPERTIES, MAX_FACET_CONTINUATIONS } from '../src/search/refinement/facet-continuation';

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
const host = document.createElement('main');
document.body.append(host);
let props: Props;
let update: (next: Props) => void;
let root: ReturnType<typeof createRoot>;
const roster = Array.from({ length: MAX_CACHED_FACET_PROPERTIES + 1 }, (_, index) => ({
  property: `schema:p${index}`,
  labels: { en: `Property ${index}` },
  mode: 'values' as const,
}));

function ready(value: string, next: string | null, property: string) {
  return {
    status: 'ready' as const,
    page: {
      as_of: '2026-01-01T00:00:00.000Z',
      facets: [{ property, values: [{ value, labels: { en: value } }], next }],
    },
  };
}

function makeProps(query: string, load: Props['load']): Props {
  return {
    data: {
      key: query,
      properties: roster as Props['data']['properties'],
      initial: ready('initial-p0', 'p0-cursor-0', 'schema:p0'),
    },
    conditions: {
      type: 'schema:Book',
      kinds: ['schema:Book'],
      languages: ['en'],
      filter: '',
      facetValues: {},
      ranges: {},
      condition: { not: { type: { in: ['schema:Movie'] } } },
    },
    query,
    locale: 'en',
    load,
    onNavigate: () => {},
  };
}

function fieldsetFor(label: string) {
  const fieldset = [...host.querySelectorAll('fieldset')].find((node) =>
    [...node.querySelectorAll('legend')].some((legend) => legend.textContent?.trim() === label),
  );
  expect(fieldset).toBeDefined();
  return fieldset!;
}

function moreFor(label: string) {
  const found = [...fieldsetFor(label).querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === m.refinement_more_values(),
  );
  expect(found).toBeDefined();
  return found!;
}

function hasMore(label: string) {
  return [...fieldsetFor(label).querySelectorAll('button')].some(
    (node) => node.textContent?.trim() === m.refinement_more_values(),
  );
}

async function replace(next: Props) {
  props = next;
  await act(async () => update(props));
}

async function selectProperty(property: string) {
  const picker = host.querySelector('select');
  expect(picker).toBeDefined();
  await act(async () => {
    picker!.value = property;
    picker!.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  setLocale('en', { reload: false });
  props = makeProps('first', async () => ready('unused', null, 'schema:p0'));
  function View() {
    const [current, setCurrent] = useState(props);
    update = setCurrent;
    return <Refinement {...current} />;
  }
  const route = createRootRoute({ component: View });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search'] }) });
  await router.load();
  root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.replaceChildren();
});

afterAll(() => {
  setLocale('en', { reload: false });
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('A newly selected retained facet property keeps cursor-cycle history and its finite continuation allowance across rerenders', async () => {
  const cursors: (string | undefined)[] = [];
  let page = 1;
  let finishBusy!: (value: ReturnType<typeof ready>) => void;
  const busyRead = new Promise<ReturnType<typeof ready>>((resolve) => (finishBusy = resolve));
  const load: Props['load'] = async (facets) => {
    const property = facets[0]!.property;
    if (property !== 'schema:p8') return ready(`fresh ${property}`, null, property);
    if (facets[0]?.cursor === undefined) return ready('selected-p8', 'cursor-0', property);
    cursors.push(facets[0].cursor);
    const values = `window-${page}`;
    const next = `cursor-${page++}`;
    return cursors.length === 1 ? busyRead : ready(values, next, property);
  };
  await replace(makeProps('first', load));
  await selectProperty('schema:p8');

  await act(async () => moreFor('Property 8').click());
  expect(host.textContent).toContain('selected-p8');
  expect(host.textContent).not.toContain('window-1');
  await replace({ ...props, showSummary: false });
  await act(async () => finishBusy(ready('window-1', 'cursor-1', 'schema:p8')));
  expect(host.textContent).toContain('window-1');
  await selectProperty('schema:p0');

  for (let index = 1; index < MAX_FACET_CONTINUATIONS; index++) await act(async () => moreFor('Property 8').click());
  expect(cursors).toEqual(Array.from({ length: MAX_FACET_CONTINUATIONS }, (_, index) => `cursor-${index}`));
  expect(host.textContent).toContain(`window-${MAX_FACET_CONTINUATIONS}`);
  expect(host.textContent).toContain(m.refinement_restart());
  expect(hasMore('Property 8')).toBe(false);

  const fresh: (string | undefined)[] = [];
  await replace(
    makeProps('second', async (facets) => {
      const property = facets[0]!.property;
      if (property !== 'schema:p8') return ready(`fresh ${property}`, null, property);
      if (facets[0]?.cursor === undefined) return ready('fresh-p8', 'cursor-0', property);
      fresh.push(facets[0].cursor);
      return ready('fresh-window', 'cursor-1', property);
    }),
  );
  await selectProperty('schema:p8');
  await act(async () => moreFor('Property 8').click());
  expect(fresh).toEqual(['cursor-0']);
  expect(host.textContent).toContain('fresh-window');
  expect(host.textContent).not.toContain(m.refinement_restart());
});

test('a replacement property keeps consumed cursors until genuine eviction removes its cache', async () => {
  const p8Cursors: (string | undefined)[] = [];
  let evicted = false;
  await replace(
    makeProps('first', async (facets) => {
      const property = facets[0]!.property;
      const cursor = facets[0]?.cursor;
      if (property === 'schema:p8') {
        p8Cursors.push(cursor);
        if (evicted) return ready('fresh schema:p8', cursor === undefined ? 'cursor-0' : 'cursor-1', property);
        if (cursor === undefined) return ready('selected-p8', 'cursor-0', property);
        if (cursor === 'cursor-0') return ready('continued-p8', 'cursor-1', property);
        return ready('cycled-p8', 'cursor-0', property);
      }
      if (property === 'schema:p0')
        return ready('later-p0', cursor === 'p0-cursor-0' ? 'p0-cursor-1' : 'p0-cursor-2', property);
      return ready(`fresh ${property}`, null, property);
    }),
  );

  await act(async () => moreFor('Property 0').click());
  await selectProperty('schema:p8');
  expect(hasMore('Property 0')).toBe(true);
  expect(host.textContent).toContain('later-p0');

  await act(async () => moreFor('Property 8').click());
  expect(p8Cursors).toEqual([undefined, 'cursor-0']);
  expect(host.textContent).toContain('continued-p8');
  await act(async () => moreFor('Property 8').click());
  expect(host.textContent).toContain(m.refinement_restart());
  expect(host.textContent).toContain('continued-p8');
  expect(host.textContent).not.toContain('cycled-p8');

  evicted = true;
  for (const index of [7, 6, 5, 4, 3, 2, 1, 0]) await selectProperty(`schema:p${index}`);
  expect(host.textContent).not.toContain('continued-p8');

  await selectProperty('schema:p8');
  await act(async () => moreFor('Property 8').click());
  expect(p8Cursors).toEqual([undefined, 'cursor-0', 'cursor-1', undefined, 'cursor-0']);
  expect(host.textContent).toContain('fresh schema:p8');
  expect(host.textContent).not.toContain(m.refinement_restart());
});
