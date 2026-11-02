import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';

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

function ready(value: string | string[], next: string | null, property = 'schema:genre') {
  return {
    status: 'ready' as const,
    page: {
      as_of: '2026-01-01T00:00:00.000Z',
      facets: [
        {
          property,
          values: (Array.isArray(value) ? value : [value]).map((entry) => ({ value: entry, labels: { en: entry } })),
          next,
        },
      ],
    },
  };
}

function makeProps(query: string, initial: ReturnType<typeof ready>, load: Props['load']): Props {
  return {
    data: {
      key: query,
      properties: [
        { property: 'schema:genre', labels: { en: 'Genre' }, mode: 'values' },
      ] as Props['data']['properties'],
      initial,
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

function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(found).toBeDefined();
  return found!;
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
  props = makeProps('first', ready('accepted one', 'opaque-a'), async () => ready('unused', null));
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

test('failed reads retry and a cyclic continuation keeps accepted values and offers restart', async () => {
  const cursors: (string | undefined)[] = [];
  let attempts = 0;
  await replace(
    makeProps('first', ready('accepted one', 'opaque-a'), async (facets) => {
      cursors.push(facets[0]?.cursor);
      attempts++;
      if (attempts === 1) return { status: 'unavailable', code: 'temporary' };
      return attempts === 2 ? ready('accepted two', 'opaque-b') : ready('discarded page', 'opaque-a');
    }),
  );

  await act(async () => button(m.refinement_more_values()).click());
  await act(async () => button(m.search_facet_retry()).click());
  await act(async () => button(m.refinement_more_values()).click());

  expect(cursors).toEqual(['opaque-a', 'opaque-a', 'opaque-b']);
  expect(host.textContent).toContain('accepted one');
  expect(host.textContent).toContain('accepted two');
  expect(host.textContent).not.toContain('discarded page');
  expect(host.textContent).toContain(m.refinement_restart());
  expect(
    [...host.querySelectorAll('button')].some((node) => node.textContent?.trim() === m.refinement_more_values()),
  ).toBe(false);
  expect([...host.querySelectorAll('a')].some((node) => node.textContent?.trim() === m.search_facet_retry())).toBe(
    true,
  );
});

test('a query change resets pagination and an older response cannot replace its values', async () => {
  let resolve!: (value: ReturnType<typeof ready>) => void;
  const pending = new Promise<ReturnType<typeof ready>>((done) => (resolve = done));
  await replace(makeProps('first', ready('first query', 'opaque-first'), async () => pending));
  await act(async () => button(m.refinement_more_values()).click());

  const freshCursors: (string | undefined)[] = [];
  await replace(
    makeProps('second', ready('second query', 'opaque-second'), async (facets) => {
      freshCursors.push(facets[0]?.cursor);
      return ready('fresh page', null);
    }),
  );
  await act(async () => {
    resolve(ready('stale page', 'opaque-stale'));
    await pending;
  });
  expect(host.textContent).toContain('second query');
  expect(host.textContent).not.toContain('stale page');

  await act(async () => button(m.refinement_more_values()).click());
  expect(freshCursors).toEqual(['opaque-second']);
  expect(host.textContent).toContain('fresh page');
});

test('More keeps the accepted window through pending and failure, retries the exact cursor, and replaces it on success', async () => {
  const firstValues = Array.from({ length: 10 }, (_, index) => `value-${index}`);
  const nextValues = Array.from({ length: 10 }, (_, index) => `value-${index + 10}`);
  const cursors: (string | undefined)[] = [];
  let finishFailure!: (value: { status: 'unavailable'; code: string }) => void;
  const failedRead = new Promise<{ status: 'unavailable'; code: string }>((resolve) => (finishFailure = resolve));
  const next = makeProps('window', ready(firstValues, 'cursor-one'), async (facets) => {
    cursors.push(facets[0]?.cursor);
    return cursors.length === 1 ? failedRead : ready(nextValues, 'cursor-two');
  });
  next.conditions.facetValues = { 'schema:genre': [firstValues[0]!] };
  await replace(next);

  await act(async () => button(m.refinement_more_values()).click());
  const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="f.schema:genre"]')];
  expect(checkboxes().map((input) => input.value)).toEqual(firstValues);
  await act(async () => finishFailure({ status: 'unavailable', code: 'temporary' }));
  expect(checkboxes().map((input) => input.value)).toEqual(firstValues);
  await act(async () => button(m.search_facet_retry()).click());

  expect(cursors).toEqual(['cursor-one', 'cursor-one']);
  expect(checkboxes().map((input) => input.value)).toEqual(nextValues);
  expect(host.querySelectorAll('input[type="hidden"][name="f.schema:genre"][value="value-0"]')).toHaveLength(1);
});

test('evicting a property frees its cache without dropping its selected predicate or reading it again', async () => {
  const properties = Array.from({ length: 9 }, (_, index) => ({
    property: `schema:p${index}`,
    labels: { en: `Property ${index}` },
    mode: 'values' as const,
  }));
  const reads: string[] = [];
  const next = makeProps('properties', ready('retained', 'cursor-p0', 'schema:p0'), async (facets) => {
    const property = facets[0]!.property;
    reads.push(property);
    return ready(`fresh ${property}`, null, property);
  });
  next.data.properties = properties;
  next.conditions.facetValues = { 'schema:p0': ['retained'] };
  await replace(next);

  for (let index = 1; index <= 8; index++) await selectProperty(`schema:p${index}`);
  expect(reads).toEqual(Array.from({ length: 8 }, (_, index) => `schema:p${index + 1}`));
  expect(host.querySelectorAll('input[type="hidden"][name="f.schema:p0"][value="retained"]')).toHaveLength(1);

  await selectProperty('schema:p0');
  expect(reads.at(-1)).toBe('schema:p0');
  expect(host.querySelectorAll('input[type="hidden"][name="f.schema:p0"][value="retained"]')).toHaveLength(1);
});

test('the finite continuation allowance keeps the last window and offers an explicit restart', async () => {
  const cursors: (string | undefined)[] = [];
  let page = 1;
  await replace(
    makeProps('finite', ready(Array.from({ length: 10 }, (_, index) => `window-0-${index}`), 'cursor-0'), async (facets) => {
      cursors.push(facets[0]?.cursor);
      const values = Array.from({ length: 10 }, (_, index) => `window-${page}-${index}`);
      return ready(values, `cursor-${page++}`);
    }),
  );

  for (let index = 0; index < 64; index++) await act(async () => button(m.refinement_more_values()).click());
  expect(cursors).toEqual(Array.from({ length: 64 }, (_, index) => `cursor-${index}`));
  expect(host.textContent).toContain('window-64-0');
  expect(host.textContent).not.toContain('window-63-0');
  expect(host.textContent).toContain(m.refinement_restart());
  expect([...host.querySelectorAll('button')].some((node) => node.textContent?.trim() === m.refinement_more_values())).toBe(
    false,
  );
});
