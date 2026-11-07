import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { BuyerOrdersCurrentRead } from '../src/checkout/orders';
import type { BuyerEntitlementsCurrentRead } from '../src/checkout/entitlements';

// UNRUN: focused presentation/current-origin outcomes for controller integration.
// Existing buyer mutation, polling and native/browser acceptance remain deferred.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import('happy-dom');
const window = new Window({ url: 'https://site.test/en/orders?cursor=private-page' });
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { flushSync } = await import('react-dom');
const orders = await import('../src/checkout/orders');
const entitlements = await import('../src/checkout/entitlements');
const { OrdersPage } = await import('../src/checkout/orders-page');
const { EntitlementsPage } = await import('../src/checkout/entitlements-page');
const { OrdersCurrent } = await import('../src/checkout/orders-current');
const { EntitlementsCurrent } = await import('../src/checkout/entitlements-current');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, locales, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();

afterAll(async () => {
  mock.restore();
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('First and later empty buyer pages use bounded localized navigation in every locale', () => {
  const host = document.createElement('main');
  const next = 'signed/+?=next&foreign=account #購入';
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    for (const kind of ['orders', 'entitlements'] as const) {
      const show = (continuation?: boolean, cursor: string | null = null) => {
        host.innerHTML = renderToStaticMarkup(
          kind === 'orders' ? (
            <OrdersPage
              page={{ orders: [], next: cursor }}
              locale={locale}
              {...(continuation ? { continuation } : {})}
            />
          ) : (
            <EntitlementsPage
              page={{ kind: 'ready', data: { entitlements: [], next: cursor } }}
              locale={locale}
              {...(continuation ? { continuation } : {})}
            />
          ),
        );
      };
      const empty = kind === 'orders' ? m.orders_empty() : m.entitlements_empty();
      const pageEmpty = kind === 'orders' ? m.orders_page_empty() : m.entitlements_page_empty();
      const nextLabel = kind === 'orders' ? m.orders_next() : m.entitlements_next();
      const pagination = kind === 'orders' ? m.orders_pagination() : m.entitlements_pagination();
      const links = () => [...host.querySelectorAll<HTMLAnchorElement>('nav a')];

      show(); // Optional provenance keeps existing first-page consumers compatible.
      expect(host.querySelector('[data-slot="empty-title"]')?.textContent).toBe(empty);
      expect(host.querySelector('nav')).toBeNull();
      show(true);
      expect(host.querySelector('[data-slot="empty-title"]')?.textContent).toBe(pageEmpty);
      expect(host.textContent).not.toContain(empty);
      expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe(pagination);
      expect(links()).toHaveLength(1);
      const first = links()[0]!;
      expect(first.textContent).toBe(m.entitlements_restart());
      expect(first.tabIndex).toBe(0);
      expect(first.getAttribute('href')).toBe(`/${locale}/${kind}`);
      expect(first.querySelector('button, a')).toBeNull();
      expect(new URL(first.href).search).toBe('');
      expect(first.getAttribute('aria-disabled')).toBeNull();

      show(true, next);
      expect(links().map((link) => link.textContent)).toEqual([m.entitlements_restart(), nextLabel]);
      expect(links()[0]!.getAttribute('href')).toBe(`/${locale}/${kind}`);
      expect(links()[1]!.getAttribute('href')).toBe(`/${locale}/${kind}?cursor=${encodeURIComponent(next)}`);
      const destination = new URL(links()[1]!.href);
      expect([...destination.searchParams]).toEqual([['cursor', next]]);
      expect(host.querySelectorAll('li')).toHaveLength(0);

      show(false, next); // Even a sparse first page cannot claim global absence when more is returned.
      expect(host.querySelector('[data-slot="empty-title"]')?.textContent).toBe(pageEmpty);
      expect(links().map((link) => link.textContent)).toEqual([nextLabel]);
    }
  }
});

test('Later entitlement failures keep their honest state and existing cursor-error recovery', () => {
  setLocale('en', { reload: false });
  const host = document.createElement('main');
  const messages = {
    unavailable: m.entitlements_unavailable(),
    preparing: m.entitlements_preparing(),
    denied: m.entitlements_denied(),
    'cursor-error': m.entitlements_cursor_error(),
  };
  for (const kind of ['unavailable', 'preparing', 'denied', 'cursor-error'] as const) {
    host.innerHTML = renderToStaticMarkup(<EntitlementsPage page={{ kind }} locale="fr" continuation />);
    expect(host.textContent).toContain(messages[kind]);
    expect(host.querySelector('[data-slot="empty"], nav')).toBeNull();
    if (kind === 'cursor-error') {
      const first = host.querySelector('[role="alert"] a')!;
      expect(first.getAttribute('href')).toBe('/fr/entitlements');
      expect(first.textContent).toBe(m.entitlements_restart());
    } else {
      expect(host.querySelector('[role="alert"] a, [role="status"] a')).toBeNull();
    }
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function emptyOrders(subject: string, cursor: string | null, locale = 'en'): BuyerOrdersCurrentRead {
  return { sessionSubject: subject, requested: { cursor, locale }, page: { orders: [], next: null } };
}
function emptyEntitlements(subject: string, cursor: string | null, locale = 'en'): BuyerEntitlementsCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', cursor, locale },
    page: { kind: 'ready', data: { entitlements: [], next: null } },
  };
}
const tick = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });

test('Current list recovery follows exact private address and retires without an extra read or late empty disclosure', async () => {
  setLocale('en', { reload: false });
  const orderReads: (ReturnType<typeof deferred<BuyerOrdersCurrentRead>> & {
    data: { cursor?: string; locale: string };
  })[] = [];
  const entitlementReads: (ReturnType<typeof deferred<BuyerEntitlementsCurrentRead>> & {
    data: { cursor?: string; locale: string };
  })[] = [];
  const orderRead = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(({ data }) => {
    const work = { ...deferred<BuyerOrdersCurrentRead>(), data };
    orderReads.push(work);
    return work.promise;
  });
  const entitlementRead = spyOn(entitlements, 'readBuyerEntitlementsCurrent').mockImplementation(({ data }) => {
    const work = { ...deferred<BuyerEntitlementsCurrentRead>(), data };
    entitlementReads.push(work);
    return work.promise;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const viewer = (subject: string, csrfToken = `csrf-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
  client.setQueryData(['session'], viewer('A'));
  client.setQueryData(['exposure', 'anonymous'], []);
  const release = lifetime.subscribe(() => {});
  const admit = (admitted = ['purchases']) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('No current viewer');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  admit();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let cursor: string | undefined = 'private-page';
  let locale = 'en';
  const show = () =>
    act(() =>
      flushSync(() =>
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>
              <OrdersCurrent
                initial={emptyOrders('A', 'private-page')}
                search={cursor ? { cursor } : {}}
                locale={locale}
              />
              <EntitlementsCurrent initial={emptyEntitlements('A', 'private-page')} locale={locale} cursor={cursor} />
            </QueryClientProvider>
          </StrictMode>,
        ),
      ),
    );
  const recovery = () => [...host.querySelectorAll('nav a')];
  const counts = () => [orderReads.length, entitlementReads.length];
  const settle = async (subject: string, requestedCursor: string | null, requestedLocale = locale) => {
    await act(async () => {
      orderReads.at(-1)!.resolve(emptyOrders(subject, requestedCursor, requestedLocale));
      entitlementReads.at(-1)!.resolve(emptyEntitlements(subject, requestedCursor, requestedLocale));
    });
    await tick();
  };
  try {
    show();
    await tick();
    expect(counts()).toEqual([0, 0]); // Certified loader pages need no extra read to expose recovery.
    expect(recovery().map((link) => link.getAttribute('href'))).toEqual(['/en/orders', '/en/entitlements']);
    show();
    await tick();
    expect(counts()).toEqual([0, 0]);

    cursor = 'second/+?=&opaque';
    locale = 'fr';
    setLocale('fr', { reload: false });
    show();
    expect(recovery()).toHaveLength(0);
    await tick();
    expect(counts()).toEqual([1, 1]);
    expect(orderReads[0]!.data).toEqual({ cursor, locale });
    expect(entitlementReads[0]!.data).toEqual({ cursor, locale });
    const oldOrders = orderReads[0]!;
    const oldEntitlements = entitlementReads[0]!;
    await act(async () => client.setQueryData(['session'], { state: 'unknown', csrfToken: null }));
    await tick();
    expect(recovery()).toHaveLength(0);
    expect(counts()).toEqual([1, 1]);

    act(() => {
      client.setQueryData(['session'], viewer('B'));
      admit();
    });
    show();
    await tick();
    expect(counts()).toEqual([2, 2]);
    await act(async () => {
      oldOrders.resolve(emptyOrders('A', cursor!, locale));
      oldEntitlements.resolve(emptyEntitlements('A', cursor!, locale));
    });
    await tick();
    expect(recovery()).toHaveLength(0);
    expect(host.querySelector('[data-slot="empty"]')).toBeNull();
    await settle('B', cursor!);
    expect(recovery().map((link) => link.getAttribute('href'))).toEqual(['/fr/orders', '/fr/entitlements']);
    expect(host.textContent).not.toContain(m.orders_empty());
    expect(host.textContent).not.toContain(m.entitlements_empty());
    expect(counts()).toEqual([2, 2]);

    act(() => {
      client.setQueryData(['session'], viewer('B', 'refreshed-B'));
      admit();
    });
    show();
    await tick();
    expect(recovery()).toHaveLength(0);
    expect(counts()).toEqual([3, 3]);
    await act(async () => admit([]));
    await tick();
    expect(counts()).toEqual([3, 3]);
    await settle('B', cursor!);
    expect(recovery()).toHaveLength(0);
    expect(host.querySelector('[data-slot="empty"]')).toBeNull();
    expect(counts()).toEqual([3, 3]);
    await act(async () => admit());
    await tick();
    expect(counts()).toEqual([4, 4]);
    await settle('B', cursor!);
    expect(recovery()).toHaveLength(2);

    // Explicit first-page navigation replaces the returned page; neither list prefetches or loops.
    cursor = undefined;
    show();
    await tick();
    expect(counts()).toEqual([5, 5]);
    expect(orderReads.at(-1)!.data).toEqual({ locale });
    expect(entitlementReads.at(-1)!.data).toEqual({ locale });
    await settle('B', null);
    expect(host.textContent).toContain(m.orders_empty());
    expect(host.textContent).toContain(m.entitlements_empty());
    expect(recovery()).toHaveLength(0);
    await tick();
    expect(counts()).toEqual([5, 5]);
  } finally {
    await act(async () => root.unmount());
    release();
    client.clear();
    host.remove();
    orderRead.mockRestore();
    entitlementRead.mockRestore();
  }
});
