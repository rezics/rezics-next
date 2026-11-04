import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorSalesCurrentRead } from '../src/checkout/creator-sales';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
// a refresh must replace accepted private data, including across healthy session rotation.
// Uses the existing viewer/query fixtures; native and browser acceptance remain deferred.
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
      projectionState: 'preparing',
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

test('a foreign refresh replaces a seeded sale with unavailable and healthy rotation cannot revive it', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const session = (csrfToken: string) => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: A, csrfToken });
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected real viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: A,
      admitted: ['selling', 'commerce_sale.list'],
    });
  };
  session('first');
  const foreign = page('019a2100-0000-7000-8000-000000000021');
  foreign.page = { kind: 'ready', sales: [], next: null, projectionState: 'ready' };
  const read = spyOn(reads, 'readCreatorSalesCurrent').mockResolvedValue(foreign);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/sales'] }),
  });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              <CreatorSalesCurrent initial={page()} locale="en" />
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await tick();
    expect(host.textContent).toContain(`Private sale ${A}`);
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['creator-sales-current'] });
    });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(`Private sale ${A}`);
    expect(host.textContent).not.toContain('No sales');
    expect(host.innerHTML).not.toContain(encodeURIComponent(`next-${A}+/=`));
    const failed = client.getQueriesData<CreatorSalesCurrentRead>({ queryKey: ['creator-sales-current'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]![1]?.page).toEqual({ kind: 'unavailable' });
    await act(async () => session('healthy-rotation'));
    await tick();
    expect(host.textContent).not.toContain(`Private sale ${A}`);
    expect(host.textContent).not.toContain('No sales');
    expect(host.innerHTML).not.toContain(encodeURIComponent(`next-${A}+/=`));
  } finally {
    await act(async () => root.unmount());
    keep();
    client.clear();
    read.mockRestore();
    host.remove();
  }
});

test('supported departure restores only the exact sale on the original admitted page and retires clipboard work', async () => {
  const { CreatorSalesPage } = await import('../src/checkout/creator-sales-page');
  const { supportedCreatorSaleDeparture } = await import('../src/checkout/creator-sale-destinations');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let finishCopy: (() => void) | undefined;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    },
  });
  let source = {};
  let current = true;
  const sale = { ...creatorSaleFixture, orderId: '019a2100-0000-7000-8000-000000000088' };
  let data = { kind: 'ready', sales: [creatorSaleFixture, sale], next: 'older+/=', projectionState: 'ready' } as const;
  const render = () =>
    act(async () =>
      root.render(<CreatorSalesPage page={data} source={source} locale="en" isCurrent={() => current} />),
    );
  const click = async (label: string, index = 0) => {
    const buttons = [...host.querySelectorAll('button')].filter((button) => button.textContent === label);
    await act(async () => buttons[index]!.click());
  };
  const event = (name: string) =>
    act(async () => {
      window.dispatchEvent(new window.Event(name));
    });
  // Prevent document navigation after React has prepared the supported departure.
  const stay = (event: Event) => event.preventDefault();
  host.addEventListener('click', stay);
  const depart = async (path: string) => {
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.getAttribute('href') === path,
    )!;
    await act(async () =>
      link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
    );
    await event('pagehide');
  };
  try {
    await render();
    await click('Inspect sale', 1);
    await click('Copy sale reference');
    await depart(`/en/offers/${sale.offerId}`);
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    await act(async () => finishCopy?.());
    await event('pageshow');
    const inspection = host.querySelector('#creator-sale-inspection')!;
    expect(inspection.textContent).toContain(sale.orderId);
    expect(inspection.textContent).not.toContain(creatorSaleFixture.orderId);
    expect(inspection.textContent).toContain('Returned to the same observed sale');
    expect(inspection.textContent).not.toContain('Sale reference copied.');
    await depart('/en/creator/statements');
    await event('pageshow');
    expect(host.querySelector('#creator-sale-inspection')?.textContent).toContain(sale.orderId);
    await depart(`/en/offers/${sale.offerId}`);
    source = {};
    data = { ...data, sales: [sale, creatorSaleFixture] };
    await render();
    await event('pageshow');
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    await click('Inspect sale');
    await depart(`/en/offers/${sale.offerId}`);
    current = false;
    await event('pageshow');
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    for (const href of [
      'https://foreign.test/en/creator/statements',
      '/en/orders/private',
      '/en/creator/statements?line=made-up',
      '/de/creator/statements',
    ])
      expect(supportedCreatorSaleDeparture(sale, 'en', href, 'https://site.test')).toBeNull();
  } finally {
    host.removeEventListener('click', stay);
    await act(async () => root.unmount());
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    host.remove();
  }
});
