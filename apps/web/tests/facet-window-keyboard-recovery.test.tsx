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
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  FocusEvent: window.FocusEvent,
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

function makeProps(query: string, initial: Props['data']['initial'], load: Props['load']): Props {
  return {
    data: {
      key: query,
      properties: [
        { property: 'schema:genre', labels: { en: 'Genre' }, mode: 'values' },
      ] as Props['data']['properties'],
      initial,
    },
    conditions: { facetValues: {} },
    query,
    locale: 'en',
    load,
    onNavigate: () => {},
  };
}

function control(text: string) {
  return [...host.querySelectorAll<HTMLElement>('button, a')].find((node) => node.textContent?.trim() === text);
}

function region() {
  return host.querySelector<HTMLElement>('fieldset[tabindex="-1"]');
}

async function replace(next: Props) {
  props = next;
  await act(async () => update(props));
}

async function press(node: HTMLElement) {
  await act(async () => {
    node.focus();
    node.click();
  });
}

beforeEach(async () => {
  setLocale('en', { reload: false });
  props = makeProps('start', ready('accepted', 'cursor-a'), async () => ready('unused', null));
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

test('explicit facet loading and More retain useful keyboard focus through page replacement and refusal', async () => {
  let resolveMore!: (value: ReturnType<typeof ready>) => void;
  await replace(
    makeProps('keep', ready('one', 'cursor-a'), async () => new Promise((done) => (resolveMore = done))),
  );
  const more = control(m.refinement_more_values())!;
  await press(more);
  expect(document.activeElement).toBe(more);
  expect((more as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolveMore(ready('two', 'cursor-b')));
  expect(document.activeElement).toBe(control(m.refinement_more_values()));

  let resolveFinal!: (value: ReturnType<typeof ready>) => void;
  await replace(
    makeProps('final', ready('one', 'cursor-a'), async () => new Promise((done) => (resolveFinal = done))),
  );
  await press(control(m.refinement_more_values())!);
  await act(async () => resolveFinal(ready('two', null)));
  expect(control(m.refinement_more_values())).toBeUndefined();
  expect(document.activeElement).toBe(region());

  let resolveLoad!: (value: ReturnType<typeof ready>) => void;
  await replace(makeProps('load', undefined, async () => new Promise((done) => (resolveLoad = done))));
  await press(control(m.refinement_load_values())!);
  await act(async () => resolveLoad(ready('loaded', 'cursor-x')));
  expect(control(m.refinement_load_values())).toBeUndefined();
  expect(document.activeElement).toBe(region());
  expect(document.activeElement).not.toBe(control(m.refinement_more_values()));

  let resolveRefuse!: (value: { status: 'refused'; code: string }) => void;
  await replace(
    makeProps('refuse', ready('one', 'cursor-a'), async () => new Promise((done) => (resolveRefuse = done))),
  );
  await press(control(m.refinement_more_values())!);
  await act(async () => resolveRefuse({ status: 'refused', code: 'platform_closed' }));
  expect(control(m.search_facet_retry())).toBeUndefined();
  expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));

  await replace(
    makeProps('restart', ready('one', 'cursor-a'), async () => ready('cycle', 'cursor-a')),
  );
  await press(control(m.refinement_more_values())!);
  expect(document.activeElement).toBe(control(m.search_facet_retry()));

  let resolveRetry!: (value: ReturnType<typeof ready>) => void;
  let attempts = 0;
  await replace(
    makeProps('retry', ready('one', 'cursor-a'), async () => {
      attempts++;
      return attempts === 1
        ? { status: 'unavailable', code: 'temporary' }
        : new Promise((done) => (resolveRetry = done));
    }),
  );
  await press(control(m.refinement_more_values())!);
  expect(document.activeElement).toBe(control(m.search_facet_retry()));
  await press(control(m.search_facet_retry())!);
  await act(async () => resolveRetry(ready('two', null)));
  expect(control(m.search_facet_retry())).toBeUndefined();
  expect(document.activeElement).toBe(region());

  const outside = document.createElement('button');
  outside.textContent = 'Outside';
  document.body.append(outside);
  let resolveAway!: (value: ReturnType<typeof ready>) => void;
  await replace(
    makeProps('away', ready('one', 'cursor-a'), async () => new Promise((done) => (resolveAway = done))),
  );
  await press(control(m.refinement_more_values())!);
  await act(async () => outside.focus());
  await act(async () => resolveAway(ready('two', null)));
  expect(document.activeElement).toBe(outside);
  outside.remove();
});
