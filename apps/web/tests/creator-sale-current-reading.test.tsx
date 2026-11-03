import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorSalesCurrentRead } from '../src/checkout/creator-sales';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
// Mounted sales journey through the existing session, exposure and Query owners.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn() {
    let server: (...args: unknown[]) => unknown = () => undefined;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client(handler: typeof server) {
        return (...args: unknown[]) => (typeof window === 'undefined' ? server : handler)(...args);
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/creator/sales' });
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');

const reads = await import('../src/checkout/creator-sales');
const { CreatorSalesCurrent } = await import('../src/checkout/creator-sales-current');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const A = '019a2100-0000-7000-8000-000000000020';
function page(subject = A, cursor: string | null = null): CreatorSalesCurrentRead {
  return {
    sessionSubject: subject,
    requested: { cursor },
    selling: true,
    page: {
      kind: 'ready',
      sales: [{ ...creatorSaleFixture, title: `Private sale ${subject}` }],
      next: `next-${subject}+/=`,
      projectionState: 'ready',
    },
  };
}
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});


for (const size of [1, 10, 20]) test(`mounted inspection at ${size} sales adds no reads and retires deferred copy on replacement`, async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const session = (subject: string | null) => {
    client.setQueryData(sessionQuery.queryKey, subject
      ? { state: 'signed-in', subject, csrfToken: `csrf-${subject}` }
      : { state: 'signed-out' });
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state === 'signed-in') client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject, admitted: ['selling', 'commerce_sale.list'],
    });
  };
  session(A);
  let initial = page();
  if (initial.page.kind !== 'ready') throw new Error('Expected fixture page');
  initial.page.sales = Array.from({ length: size }, (_, i) => ({ ...creatorSaleFixture,
    orderId: `019a2100-0000-7000-8000-${String(i).padStart(12, '0')}`,
    title: `Private sale ${i} / ${'長い値'.repeat(80)}`,
  }));
  const read = spyOn(reads, 'readCreatorSalesCurrent').mockImplementation(async () => initial);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({ routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/sales?cursor=opaque%2B%2F%3D'] }) });
  const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  let locale = 'en';
  let cursor: string | undefined;
  const render = () => act(async () => root.render(
    <StrictMode><QueryClientProvider client={client}><RouterContextProvider router={router}>
      <CreatorSalesCurrent initial={initial} locale={locale} {...(cursor ? { cursor } : {})} />
    </RouterContextProvider></QueryClientProvider></StrictMode>,
  ));
  const buttons = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => button.textContent === text);
  const click = async (text: string) => {
    const button = buttons(text)[0];
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
    return button;
  };
  const inspection = () => host.querySelector('#creator-sale-inspection');
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    await render(); await tick();
    expect(read).not.toHaveBeenCalled();
    expect(buttons('Inspect sale')).toHaveLength(size);
    const opener = await click('Inspect sale');
    expect(document.activeElement?.id).toBe('creator-sale-inspection-heading');
    expect(inspection()?.textContent).toContain(creatorSaleFixture.createdAt);
    const links = [...inspection()!.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe(`/en/offers/${creatorSaleFixture.offerId}`);
    expect(host.innerHTML).not.toContain('/orders/');
    expect(read).not.toHaveBeenCalled();
    let finishCopy: (() => void) | undefined;
    let copiedText = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText(text: string) { copiedText = text; return new Promise<void>((resolve) => { finishCopy = resolve; }); },
    } });
    await click('Copy sale reference');
    expect(copiedText).toMatch(/^Sale reference: 019a2100/);
    expect(inspection()?.textContent).toContain('Copying reference');
    // Replacement has identical sale IDs and terms, yet is a fresh source observation.
    await act(async () => client.setQueriesData<CreatorSalesCurrentRead>({ queryKey: ['creator-sales-current'] },
      (value) => value ? { ...value, page: { ...value.page } } : value));
    await tick();
    expect(inspection()).toBeNull();
    await act(async () => finishCopy?.()); await tick();
    expect(host.textContent).not.toContain('Sale reference copied.');
    await click('Inspect sale');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await click('Copy sale reference');
    expect(inspection()?.textContent).toContain('Select and copy');
    await act(async () => inspection()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(inspection()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(read).not.toHaveBeenCalled();
    // Closing/reopening the same identity cannot accept the prior selection's completion.
    await click('Inspect sale');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText() { return new Promise<void>((resolve) => { finishCopy = resolve; }); },
    } });
    await click('Copy sale reference');
    await click('Close and return to sales'); await click('Inspect sale');
    await act(async () => finishCopy?.()); await tick();
    expect(inspection()?.textContent).not.toContain('Sale reference copied.');
    // An explicit native refresh retires equal-ID readings without extra inspection reads.
    await act(async () => { await client.invalidateQueries({ queryKey: ['creator-sales-current'] }); });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(inspection()).toBeNull();
    await click('Inspect sale');
    initial = { ...initial, page: initial.page.kind === 'ready'
      ? { ...initial.page, sales: initial.page.sales.map((sale) => ({ ...sale, title: 'Replacement loader reading' })) }
      : initial.page };
    await render(); await tick();
    expect(inspection()).toBeNull();
    expect(host.textContent).toContain('Replacement loader reading');
    await click('Inspect sale');
    locale = 'de'; await render(); await tick();
    expect(inspection()).toBeNull();
    await click('Inspect sale');
    cursor = 'opaque+/=';
    initial = { ...initial, requested: { cursor } };
    await render(); await tick();
    expect(inspection()).toBeNull();
    await click('Inspect sale');
    expect(host.innerHTML).toContain('cursor=opaque%2B%2F%3D');
    await act(async () => session(null)); await tick();
    expect(inspection()).toBeNull();
    expect(host.textContent).not.toContain('Replacement loader reading');
    expect(host.innerHTML).not.toContain(creatorSaleFixture.offerId);
    const B = '019a2100-0000-7000-8000-000000000021';
    initial = { ...page(B, cursor), page: { kind: 'ready', sales: [], next: null, projectionState: 'ready' } };
    await act(async () => session(B)); await render(); await tick();
    expect(inspection()).toBeNull();
    expect(host.textContent).not.toContain('Replacement loader reading');
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    await act(async () => root.unmount());
    keep(); client.clear(); read.mockRestore(); host.remove();
  }
});
