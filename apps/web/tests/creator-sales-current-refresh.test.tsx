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
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  useRouter,
} = await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');

const reads = await import('../src/checkout/creator-sales');
const { CreatorSalesCurrent, navigateCreatorSales } = await import('../src/checkout/creator-sales-current');
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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

test('three windows return through exact Previous and failed Restart retry without retaining inspection', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: A, csrfToken: 'window-visit' });
  const snapshot = lifetime.getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected viewer');
  client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
    subject: A,
    admitted: ['selling', 'commerce_sale.list'],
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/sales'] }),
  });
  let cursor: string | undefined;
  let locationKey = 'initial-location';
  let loadId = 'initial-load';
  const native = (target?: string): CreatorSalesCurrentRead => {
    const value = page(A, target ?? null);
    value.page = {
      kind: 'ready',
      sales: target === 'third+/=' ? [] : [creatorSaleFixture],
      next: target === 'third+/=' ? null : target ? 'third+/=' : 'second+/=',
      projectionState: 'ready',
    };
    return value;
  };
  let initial = native();
  let fail = false;
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const requested: (string | undefined)[] = [];
  const read = spyOn(reads, 'readCreatorSalesCurrent').mockImplementation(async ({ data }) => {
    requested.push(data.cursor);
    if (held) await held;
    const value = native(data.cursor);
    if (fail) value.page = { kind: 'unavailable' };
    return value;
  });
  const show = () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <CreatorSalesCurrent
            initial={initial}
            loadId={loadId}
            locationKey={locationKey}
            cursor={cursor}
            locale="en"
            navigate={async (href, started) => {
              cursor = new URL(href, 'https://site.test').searchParams.get('cursor') ?? undefined;
              locationKey = `movement-${requested.length + 1}`;
              started(locationKey);
              initial = await reads.readCreatorSalesCurrent({ data: cursor ? { cursor } : {} });
              loadId = `loaded-${requested.length}`;
              show();
              return { locationKey, loadId };
            }}
          />
        </RouterContextProvider>
      </QueryClientProvider>,
    );
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const click = async (label: string, keyboard = false) => {
    const element = [...host.querySelectorAll<HTMLElement>('a,button')].find((item) => item.textContent === label)!;
    expect(element).toBeDefined();
    if (keyboard) element.focus();
    await act(async () =>
      element.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: keyboard ? 0 : 1 }),
      ),
    );
    await tick();
  };
  const stay = (event: Event) => event.preventDefault();
  host.addEventListener('click', stay);
  try {
    await act(async () => show());
    await tick();
    const next = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent === 'Older sales')!;
    expect(next.getAttribute('href')).toBe('/en/creator/sales?cursor=second%2B%2F%3D');
    await act(async () =>
      next.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })),
    );
    expect(requested).toHaveLength(0);
    await click('Older sales', true);
    expect(document.activeElement?.id).toBe('creator-sales-heading');
    await click('Inspect sale');
    expect(host.querySelector('#creator-sale-inspection')).not.toBeNull();
    await click('Open offer');
    await act(async () => {
      window.dispatchEvent(new window.Event('pagehide'));
    });
    window.history.replaceState(null, '', 'https://site.test/en/creator/sales?cursor=second%2B%2F%3D');
    await act(async () => {
      window.dispatchEvent(new window.Event('pageshow'));
    });
    expect(host.querySelector('#creator-sale-inspection')).not.toBeNull();
    await click('Older sales');
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    expect(host.textContent).toContain('No sales on this page');
    expect(host.textContent).toContain('Previous sales');
    fail = true;
    await click('Previous sales');
    expect(host.textContent).toContain('Retry this window');
    fail = false;
    await click('Retry this window');
    expect(cursor).toBe('second+/=');
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    await click('Previous sales');
    expect(cursor).toBeUndefined();
    expect(host.textContent).not.toContain('Previous sales');
    await click('Older sales');
    fail = true;
    await click('Back to latest sales');
    fail = false;
    await click('Retry this window');
    expect(host.textContent).not.toContain('Previous sales');
    expect(requested).toEqual([
      'second+/=',
      'third+/=',
      'second+/=',
      'second+/=',
      undefined,
      'second+/=',
      undefined,
      undefined,
    ]);
    await click('Inspect sale');
    await click('Refresh');
    expect(host.querySelector('#creator-sale-inspection')).toBeNull();
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await click('Older sales');
    await act(async () => {
      const current = client.getQueriesData<CreatorSalesCurrentRead>({ queryKey: ['creator-sales-current'] })[0]!;
      client.setQueryData(current[0], current[1]);
    });
    await tick();
    await act(async () => {
      release!();
    });
    held = undefined;
    await tick();
    expect(host.textContent).not.toContain('Previous sales');
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await click('Older sales');
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: A,
        csrfToken: 'replacement-during-movement',
      }),
    );
    await tick();
    await act(async () => {
      release!();
    });
    held = undefined;
    await tick();
    expect(host.textContent).not.toContain('Previous sales');
  } finally {
    host.removeEventListener('click', stay);
    await act(async () => root.unmount());
    keep();
    client.clear();
    read.mockRestore();
    host.remove();
  }
});

test('a delayed move superseded at the same cursor retires its path before a fresh movement and exact retry', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: A, csrfToken: 'route-visit' });
  const snapshot = lifetime.getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected viewer');
  client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
    subject: A,
    admitted: ['selling', 'commerce_sale.list'],
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let fail = false;
  let routeLoad = 0;
  const requested: (string | undefined)[] = [];
  const firstDelayed = deferred();
  const replacementDelayed = deferred();
  const delayed = [firstDelayed, replacementDelayed];
  const native = (cursor?: string): CreatorSalesCurrentRead => {
    const value = page(A, cursor ?? null);
    value.page = {
      kind: 'ready',
      sales: cursor === 'third+/=' ? [] : [creatorSaleFixture],
      next: cursor === 'third+/=' ? null : cursor ? 'third+/=' : 'second+/=',
      projectionState: 'ready',
    };
    return value;
  };
  const read = spyOn(reads, 'readCreatorSalesCurrent').mockImplementation(async ({ data }) => {
    requested.push(data.cursor);
    if (data.cursor === 'second+/=' && delayed.length) return delayed.shift()!.promise;
    const value = native(data.cursor);
    if (fail) value.page = { kind: 'unavailable' };
    return value;
  });
  const rootRoute = createRootRoute({ component: Outlet });
  let salesRouteId = '';
  const salesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/creator/sales',
    validateSearch: (search) => ({ cursor: typeof search.cursor === 'string' ? search.cursor : undefined }),
    loaderDeps: ({ search }) => search,
    staleTime: 0,
    gcTime: 0,
    loader: async ({ deps }) => ({
      loadId: `sales-load-${++routeLoad}`,
      initial: await reads.readCreatorSalesCurrent({ data: deps.cursor ? { cursor: deps.cursor } : {} }),
    }),
    component: function SalesRoute() {
      const router = useRouter();
      const data = router.state.matches.at(-1)!.loaderData as {
        initial: CreatorSalesCurrentRead;
        loadId: string;
      };
      const cursor = (router.state.location.search as { cursor?: string }).cursor;
      return (
        <CreatorSalesCurrent
          initial={data.initial}
          loadId={data.loadId}
          locationKey={router.state.location.key}
          cursor={cursor}
          locale="en"
          navigate={(href, started) => navigateCreatorSales(router, salesRouteId, href, started)}
        />
      );
    },
  });
  salesRouteId = salesRoute.id;
  const router = createRouter({
    routeTree: rootRoute.addChildren([salesRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/creator/sales'] }),
  });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const click = async (label: string) => {
    const element = [...host.querySelectorAll<HTMLElement>('a,button')].find((item) => item.textContent === label)!;
    expect(element).toBeDefined();
    await act(async () =>
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
    );
    await tick();
  };
  const stay = (event: Event) => event.preventDefault();
  host.addEventListener('click', stay);
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    await click('Older sales');
    expect(requested.at(-1)).toBe('second+/=');
    let replacement!: Promise<void>;
    await act(async () => {
      replacement = router.navigate({ href: '/en/creator/sales?cursor=second%2B%2F%3D' });
      await Promise.resolve();
    });
    expect(requested.filter((cursor) => cursor === 'second+/=')).toHaveLength(2);
    await act(async () => {
      replacementDelayed.resolve(native('second+/='));
      await replacement;
    });
    await act(async () => {
      firstDelayed.resolve(native('second+/='));
    });
    await tick();
    expect(router.state.location.search).toEqual({ cursor: 'second+/=' });
    expect(host.textContent).not.toContain('Previous sales');
    await click('Older sales');
    expect(host.textContent).toContain('Previous sales');
    fail = true;
    await click('Previous sales');
    expect(host.textContent).toContain('Retry this window');
    fail = false;
    await click('Retry this window');
    expect(requested.at(-1)).toBe('second+/=');
    expect(router.state.location.search).toEqual({ cursor: 'second+/=' });
    expect(host.textContent).not.toContain('Previous sales');
  } finally {
    host.removeEventListener('click', stay);
    await act(async () => root.unmount());
    keep();
    client.clear();
    read.mockRestore();
    host.remove();
  }
});
