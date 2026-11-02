import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?cursor=old-hit-token' });
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
const navigations: string[] = [];
const host = document.createElement('main');
document.body.append(host);
let props: Props;
let update: (next: Props) => void;
let root: ReturnType<typeof createRoot>;

function conditions(dateRange?: { gte: number; lte: number }) {
  return {
    type: 'schema:Book',
    kinds: ['schema:Book', 'account'],
    languages: ['ja', 'en'],
    filter: '{"type":{"in":["schema:CreativeWork"]}}',
    facetValues: { 'schema:genre': ['fixture:literature'], 'schema:inLanguage': ['en'] },
    ranges: {
      ...(dateRange ? { 'schema:datePublished': dateRange } : {}),
      'fixture:price': { gte: 2, unit: 'EUR' },
    },
    condition: { not: { type: { in: ['schema:Movie'] } } },
  };
}

function makeProps(nextConditions: Props['conditions']): Props {
  return {
    data: {
      key: 'range-removal',
      properties: [
        {
          property: 'schema:datePublished',
          labels: { en: 'Published' },
          mode: 'range',
          datatype: 'time',
          units: [],
        },
      ],
    },
    conditions: nextConditions,
    query: 'reading',
    locale: 'en',
    sort: 'rating',
    load: async () => {
      throw new Error('Facet loading is not part of this range control scenario');
    },
    onNavigate: (href) => {
      navigations.push(href);
    },
  };
}

function control(text: string) {
  const found = [...host.querySelectorAll<HTMLElement>('button, a')].find((node) => node.textContent?.trim() === text);
  expect(found).toBeDefined();
  return found!;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function replace(patch: Partial<Props>) {
  props = { ...props, ...patch };
  await act(async () => update(props));
}

beforeEach(async () => {
  navigations.length = 0;
  setLocale('en', { reload: false });
  props = makeProps(conditions({ gte: 1800, lte: 1850 }));
  function View() {
    const [current, setCurrent] = useState(props);
    update = setCurrent;
    return <Refinement {...current} />;
  }
  const route = createRootRoute({ component: View });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/search?cursor=old-hit-token'] }),
  });
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

test('an applied range can be removed while blank drafts stay invalid and committed changes reset the editor', async () => {
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  await act(async () => {
    setValue(inputs[0]!, '');
    setValue(inputs[1]!, '');
  });
  await act(async () => control(m.search_apply()).click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.refinement_invalid_range());
  expect(navigations).toHaveLength(0);

  await act(async () => {
    setValue(inputs[0]!, '1900');
    setValue(inputs[1]!, '1950');
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => control(m.search_apply()).click());
  expect(new URL(navigations[0]!, 'https://search.test').searchParams.get('r.schema:datePublished')).toBe(
    JSON.stringify({ gte: 1900, lte: 1950 }),
  );

  await replace({ conditions: conditions({ gte: 2000, lte: 2010 }) });
  expect(inputs[0]!.value).toBe('2000');
  expect(inputs[1]!.value).toBe('2010');
  navigations.length = 0;
  await act(async () => control(m.refinement_range_remove_action()).click());

  const url = new URL(navigations[0]!, 'https://search.test');
  const params = url.searchParams;
  expect(url.pathname).toBe('/en/search');
  expect(params.get('q')).toBe('reading');
  expect(params.get('type')).toBe('schema:Book');
  expect(params.get('sort')).toBe('rating');
  expect(params.getAll('kinds')).toEqual(['schema:Book', 'account']);
  expect(params.getAll('language')).toEqual(['ja', 'en']);
  expect(params.get('filter')).toBe(conditions().filter);
  expect(params.get('condition')).toBe(JSON.stringify(conditions().condition));
  expect(params.get('f.schema:genre')).toBe('fixture:literature');
  expect(params.get('f.schema:inLanguage')).toBe('en');
  expect(params.has('r.schema:datePublished')).toBe(false);
  expect(params.get('r.fixture:price')).toBe(JSON.stringify({ gte: 2, unit: 'EUR' }));
  expect(params.has('cursor')).toBe(false);

  await replace({ conditions: conditions() });
  expect(inputs[0]!.value).toBe('');
  expect(inputs[1]!.value).toBe('');
  expect(
    [...host.querySelectorAll('a')].some((link) => link.textContent?.trim() === m.refinement_range_remove_action()),
  ).toBe(false);
});
