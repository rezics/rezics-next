import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { BuyerOrder, BuyerOrdersCurrentRead } from '../src/checkout/orders';
import type { OrderHistorySearch } from '../src/checkout/order-history-address';
import type { SessionEnv } from '../src/session/client';
import paid from '../src/kernel/recorded/order-paid.json';

// UNRUN at this source boundary. Mounted actual route and real prepared/generated server reads;
// original acceptance, native services, receipt reconciliation and browser proof remain deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/orders' });
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

const cookie = `__Host-rezics_session=${'a'.repeat(43)}`;
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let preparedViewer = 'A';
let preparations = 0;
let identities = 0;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid order:read',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: () => ({
      credential: async () => {
        preparations++;
        return {
          status: preparation,
          subject: preparedViewer,
          accessToken: `credential-${preparedViewer}`,
          csrfToken: `csrf-${preparedViewer}`,
        };
      },
      signedIn: async () => {
        identities++;
        return { signedIn: true, subject: 'B', csrfToken: 'csrf-B' };
      },
    }),
  },
};
const request = () => new Request('https://site.test/en/orders?accountId=foreign', { headers: { cookie } });
let currentRequest = request();
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const orders = await import('../src/checkout/orders');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function order(viewer: string, n = viewer === 'A' ? 1 : 2): BuyerOrder {
  return {
    ...paid.order,
    id: id(n),
    entitlementId: id(n + 1000),
    title: `Captured purchase ${viewer}`,
    settlement: 'paid',
    offerRevision: 1,
    currency: 'usd',
    unitAmountMinor: viewer === 'A' ? 123456 : 78901,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    taxCode: 'txcd_10302000',
    amountTaxMinor: null,
    contentEdition: null,
  };
}
function response(viewer: string, cursor: string | null = null, locale = 'en'): BuyerOrdersCurrentRead {
  return {
    sessionSubject: viewer,
    requested: { cursor, locale },
    page: { orders: [order(viewer)], next: `signed-next-${viewer}/+?=` },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Actual history provenance belongs to its one prepared native dispatch, preserving legacy refusal, bounds and failure semantics', async () => {
  const { prepareSession, sessionSubject, viewerCredential } = await import('../src/session/request');
  const { kernelClient } = await import('../src/kernel/client');
  const calls: Request[] = [];
  let body: unknown = { orders: Array.from({ length: 20 }, (_, n) => order('A', n + 10)), next: 'signed/+?=next' };
  let status = 200;
  let fail = false;
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(new Request(input, init));
    preparedViewer = 'B'; // A's dispatch must not be stamped with a later identity observation.
    if (fail) throw new Error('offline');
    return Response.json(body, { status });
  });
  try {
    const before = preparations;
    const value = await orders.readBuyerOrdersCurrent({ data: { cursor: 'opaque/+?=cursor', locale: 'fr' } });
    expect(value).toEqual({
      sessionSubject: 'A',
      requested: { cursor: 'opaque/+?=cursor', locale: 'fr' },
      page: body,
    });
    expect(preparations - before).toBe(1);
    expect(identities).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1/orders');
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual({ limit: '20', cursor: 'opaque/+?=cursor' });
    expect(call.headers.get('authorization')).toBe('Bearer credential-A');
    expect(call.headers.get('accept-language')).toStartWith('fr');
    expect(call.cache).toBe('no-store');
    expect(call.redirect).toBe('manual');
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify(value)).not.toContain('credential-');

    body = response('A').page;
    preparedViewer = 'A';
    currentRequest = request();
    await prepareSession(currentRequest, env as unknown as Partial<SessionEnv>);
    expect(sessionSubject(currentRequest)).toBe('A');
    preparation = 'absent';
    const count = calls.length;
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toMatchObject({ isNotFound: true });
    await expect(orders.readBuyerOrders({ data: {} })).rejects.toMatchObject({ isNotFound: true });
    expect(viewerCredential(currentRequest)).toBe('Bearer credential-A');
    expect(calls).toHaveLength(count);
    preparation = 'unavailable';
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    await expect(orders.readBuyerOrders({ data: {} })).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    expect(calls).toHaveLength(count);

    // Missing preparation on a genuinely cached Request cannot certify its retained subject/credential.
    preparation = 'active';
    currentRequest.headers.delete('cookie');
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toMatchObject({ isNotFound: true });
    expect(calls).toHaveLength(count);
    currentRequest.headers.set('authorization', 'Bearer explicit-B');
    expect(await orders.readBuyerOrdersCurrent({ data: { cursor: '', locale: 'en' } })).toEqual({
      sessionSubject: null,
      requested: { cursor: null, locale: 'en' },
      page: body,
    });
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer explicit-B');
    expect(await orders.readBuyerOrders({ data: {} })).toEqual(body);
    expect(await orders.loadBuyerOrders(kernelClient(), currentRequest, {}, {})).toEqual(body);
    expect((await orders.readBuyerOrders({ data: { locale: 'invalid' } as never })).orders).toHaveLength(1);
    currentRequest.headers.set('cookie', cookie);
    expect((await orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).sessionSubject).toBeNull();

    const validCalls = calls.length;
    await expect(async () => orders.readBuyerOrdersCurrent({ data: { locale: 'invalid' } })).rejects.toMatchObject({
      isNotFound: true,
    });
    await expect(async () =>
      orders.readBuyerOrdersCurrent({ data: { locale: 'en', cursor: 'x'.repeat(4097) } }),
    ).rejects.toMatchObject({ isNotFound: true });
    await expect(async () => orders.readBuyerOrders({ data: { cursor: 42 } as never })).rejects.toMatchObject({
      isNotFound: true,
    });
    expect(calls).toHaveLength(validCalls);
    status = 404;
    body = { code: 'not_found' };
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toMatchObject({ isNotFound: true });
    await expect(orders.readBuyerOrders({ data: {} })).rejects.toMatchObject({ isNotFound: true });
    status = 503;
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toThrow(
      'Native order history is unavailable',
    );
    status = 200;
    body = { orders: Array.from({ length: 21 }, () => order('A')), next: null };
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toThrow(
      'Invalid native order history response',
    );
    body = { orders: [{ ...order('A'), settlement: 'invented' }], next: null };
    await expect(orders.readBuyerOrders({ data: {} })).rejects.toThrow('Invalid native order history response');
    fail = true;
    await expect(orders.readBuyerOrdersCurrent({ data: { locale: 'en' } })).rejects.toThrow(
      'Native order history is unavailable',
    );
    fail = false;
    body = { orders: [], next: null };
    expect(await orders.readBuyerOrders({ data: {} })).toEqual(body);
    expect(calls.every((read) => new URL(read.url).pathname === '/v1/orders')).toBe(true);
  } finally {
    native.mockRestore();
    preparation = 'active';
    preparedViewer = 'A';
    currentRequest = request();
  }
});

test('The actual Orders history route retires replaced-buyer history and rejects late or mismatched actual reader provenance without changing receipt reconciliation', async () => {
  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider, notFound } =
    await import('@tanstack/react-router');
  const { Route } = await import('../src/routes/orders/index');
  const { OrdersPage } = await import('../src/checkout/orders-page');
  const shell = await import('../src/shell/shell');
  const { requireSignedIn } = await import('../src/session/guard');
  expect(Route.options.beforeLoad).toBe(requireSignedIn);
  const validate = Route.options.validateSearch as (search: Record<string, unknown>) => OrderHistorySearch;
  expect(validate({ cursor: 'signed/+?=' })).toEqual({ cursor: 'signed/+?=' });
  expect(validate({ cursor: 'x'.repeat(4097) }).cursor).toBe('x'.repeat(4097));
  expect(Route.options.loaderDeps!({ search: { cursor: 'opaque' } } as never)).toEqual({ cursor: 'opaque' });

  const historical = document.createElement('section');
  historical.innerHTML = renderToString(
    <OrdersPage
      locale="en"
      page={{
        next: null,
        orders: [
          order('A'),
          {
            ...order('B'),
            currency: 'jpy',
            unitAmountMinor: 500,
            moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
            settlement: 'pending',
            entitlementId: null,
          },
          { ...order('C', 3), settlement: 'failed', entitlementId: null, moneyUnit: null, taxBehavior: null },
          { ...order('D', 4), settlement: 'unknown', entitlementId: null },
        ],
      }}
    />,
  );
  expect(historical.querySelectorAll('[data-order-row]')).toHaveLength(4);
  expect(historical.querySelector('[data-settlement="paid"]')!.textContent).toContain(m.orders_entitlement_recorded());
  expect(historical.querySelector('[data-settlement="pending"]')!.textContent).toContain('¥500');
  expect(historical.querySelector('[data-settlement="pending"]')!.textContent).toContain(
    m.orders_entitlement_pending(),
  );
  expect(historical.querySelector('[data-settlement="failed"]')!.textContent).toContain(
    m.statements_amount_unavailable(),
  );
  expect(historical.querySelector('[data-settlement="failed"]')!.textContent).toContain(m.commerce_tax_unknown());
  expect(historical.querySelector('[data-settlement="failed"]')!.textContent).toContain(m.orders_entitlement_none());
  expect(historical.querySelector('[data-settlement="unknown"]')!.textContent).toContain(m.orders_status_unknown());
  expect(historical.querySelector('[data-settlement="unknown"]')!.textContent).toContain(
    m.orders_entitlement_pending(),
  );

  // Seed from the actual loader and its real prepared native read, not a claimed expected viewer.
  const native = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response('A').page));
  const load = Route.options.loader as (input: { deps: { cursor?: string } }) => Promise<BuyerOrdersCurrentRead>;
  let initial: BuyerOrdersCurrentRead;
  try {
    for (const cursor of [null, 42, false, ['opaque'], { cursor: 'opaque' }, 'x'.repeat(4097)]) {
      const search = validate({ cursor, ordersCursor: 'return-only', entitlementsCursor: 'benefits/+?=' });
      const deps = Route.options.loaderDeps!({ search } as never);
      expect(await load({ deps } as never)).toBeNull();
    }
    expect(native).not.toHaveBeenCalled();
    const suffix = '/+?= &%#購入';
    const opaque = 'x'.repeat(4096 - suffix.length) + suffix;
    expect(validate(Object.fromEntries(new URLSearchParams({ cursor: opaque }))).cursor).toBe(opaque);
    await load({ deps: { cursor: opaque } });
    const input = native.mock.calls[0]![0];
    const dispatched = new URL(input instanceof Request ? input.url : String(input));
    expect(dispatched.searchParams.get('cursor')).toBe(opaque);
    initial = await load({ deps: {} });
    expect(initial.sessionSubject).toBe('A');
    expect(native).toHaveBeenCalledTimes(2);
  } finally {
    native.mockRestore();
  }
  const Page = Route.options.component!;
  let search: OrderHistorySearch = {};
  const loader = spyOn(Route, 'useLoaderData').mockImplementation(() => initial);
  const address = spyOn(Route, 'useSearch').mockImplementation(() => search);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['orders'], response('FOREIGN').page);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/orders'] }),
  });
  const invalidate = spyOn(router, 'invalidate');
  let retry: (() => void) | undefined;
  const NativeErrorPage = shell.ErrorPage;
  // Capture the originating callback while retaining the ordinary generic error UI.
  const errorPage = spyOn(shell, 'ErrorPage').mockImplementation((props) => {
    retry = props?.onRetry;
    return <NativeErrorPage {...props} />;
  });
  const reads: (ReturnType<typeof deferred<BuyerOrdersCurrentRead>> & { data: { cursor?: string; locale: string } })[] =
    [];
  const read = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(({ data }) => {
    const work = { ...deferred<BuyerOrdersCurrentRead>(), data };
    reads.push(work);
    return work.promise;
  });
  const host = document.createElement('main');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <Page />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const viewer = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = (session: { state: string; subject?: string; csrfToken: string | null }, admitted = true) => {
    act(() =>
      flushSync(() => {
        client.setQueryData(['session'], session);
        client.setQueryData(['exposure', 'viewer'], admitted ? ['purchases'] : []);
        client.setQueryData(['exposure', 'anonymous'], []);
        root!.render(tree());
      }),
    );
  };
  const absent = (who: string) => {
    expect(host.textContent).not.toContain(`Captured purchase ${who}`);
    expect(host.querySelector(`[data-order-id="${id(who === 'A' ? 1 : 2)}"]`)).toBeNull();
    expect(host.innerHTML).not.toContain(`/orders/${id(who === 'A' ? 1 : 2)}`);
    expect(host.innerHTML).not.toContain(encodeURIComponent(`signed-next-${who}/+?=`));
    expect(host.innerHTML).not.toContain(id(who === 'A' ? 1001 : 1002));
    expect(host.textContent).not.toContain(who === 'A' ? '$1,234.56' : '$789.01');
  };
  const unknown = () => {
    expect(host.querySelector('[data-order-row]')).toBeNull();
    expect(host.textContent).not.toContain(m.orders_empty());
  };
  const settle = async (work: (typeof reads)[number], value: BuyerOrdersCurrentRead) => {
    await act(async () => {
      work.resolve(value);
    });
    await tick();
  };
  try {
    client.setQueryData(['session'], viewer('A'));
    client.setQueryData(['exposure', 'viewer'], ['purchases']);
    const html = renderToString(tree());
    expect(html).toContain('Captured purchase A');
    expect(html).toContain('$1,234.56');
    expect(html).toContain(encodeURIComponent(response('A').page.next!));
    search = { cursor: ['malformed'], entitlementsCursor: 'benefits/+?= &%#所有' };
    const recovery = renderToString(tree());
    expect(recovery).toContain(m.buyer_orders_address_heading());
    expect(recovery).not.toContain('Captured purchase A');
    expect(recovery).toContain('aria-labelledby="buyer-orders-address-heading"');
    search = {};
    const certified = initial;
    initial = { ...initial, sessionSubject: null };
    expect(renderToString(tree())).not.toContain('Captured purchase A');
    initial = { ...certified, requested: { cursor: 'other', locale: 'en' } };
    expect(renderToString(tree())).not.toContain('Captured purchase A');
    initial = certified;
    host.innerHTML = html;
    const hydrationErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(host, tree(), { onRecoverableError: (e) => hydrationErrors.push(e) });
    });
    await tick();
    expect(hydrationErrors).toEqual([]);
    expect(host.textContent).toContain('Captured purchase A');
    expect(reads).toHaveLength(1);
    const oldA = reads[0]!;

    show(viewer('B'));
    absent('A'); // Synchronous committed render, before waiting for effects or B's response.
    unknown();
    await tick();
    await settle(reads.at(-1)!, response('B'));
    expect(host.textContent).toContain('Captured purchase B');
    expect(host.textContent).toContain('$789.01');
    absent('A'); // B is usable while A's native continuation is still pending.
    await settle(oldA, response('A'));
    expect(host.textContent).toContain('Captured purchase B');
    absent('A');
    search = { cursor: 'pending-before-malformed' };
    show(viewer('B'));
    await tick();
    const lateBeforeMalformed = reads.at(-1)!;
    const beforeMalformed = reads.length;
    search = { cursor: null };
    show(viewer('B'));
    absent('B');
    await tick();
    await settle(lateBeforeMalformed, response('B', 'pending-before-malformed'));
    absent('A');
    absent('B');
    expect(reads).toHaveLength(beforeMalformed);
    search = {};
    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, response('B'));
    expect(host.textContent).toContain('Captured purchase B');

    show(viewer('A'));
    absent('A'); // ABA cannot resurrect the original loader or A's settled cache entry.
    absent('B');
    unknown();
    await tick();
    const abaSuccessA = reads.at(-1)!;
    show(viewer('B'));
    absent('B');
    await tick();
    await settle(reads.at(-1)!, response('B'));
    show(viewer('A'));
    absent('A');
    await tick();
    const lateFailureA = reads.at(-1)!;
    await settle(abaSuccessA, response('A'));
    absent('A'); // A's previous lifetime cannot complete the new A read during ABA.
    unknown();
    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, response('B'));
    await act(async () => {
      lateFailureA.reject(new Error('late A failure'));
    });
    await tick();
    expect(host.textContent).toContain('Captured purchase B');
    expect(host.textContent).not.toContain(m.error_heading());
    absent('A');

    const admittedReads = reads.length;
    show({ state: 'unknown', csrfToken: null });
    absent('B');
    unknown();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    show({ state: 'signed-in', csrfToken: null });
    unknown();
    show({ state: 'signed-out', csrfToken: null });
    absent('B');
    unknown();
    expect(host.textContent).toContain(m.not_found_heading());
    show(viewer('B'), false);
    absent('B');
    unknown();
    expect(host.textContent).toContain(m.not_found_heading());
    show({ state: 'unavailable', csrfToken: null });
    unknown();
    expect(host.textContent).toContain(m.error_heading());
    expect(reads).toHaveLength(admittedReads);

    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, response('B'));
    show(viewer('B'), false);
    absent('B');
    show(viewer('B'));
    absent('B'); // Re-admission creates a fresh lifetime too.
    await tick();
    await settle(reads.at(-1)!, response('B'));

    search = { cursor: 'viewer-address' };
    show(viewer('B'));
    absent('B');
    await tick();
    expect(reads.at(-1)!.data).toEqual({ cursor: 'viewer-address', locale: 'en' });
    await settle(reads.at(-1)!, response('A', 'viewer-address'));
    absent('A');
    unknown();
    expect(host.textContent).toContain(m.error_heading());
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === m.status_retry())).toBe(true);
    expect(retry).toBeDefined();
    const obsoleteRetry = retry!;
    const beforeRepair = reads.length;
    search = { cursor: 42, ordersCursor: 'return-only', entitlementsCursor: 'benefits/+?= &%#所有' };
    show(viewer('B'));
    act(() => obsoleteRetry());
    await tick();
    expect(reads).toHaveLength(beforeRepair);
    expect(host.textContent).toContain(m.buyer_orders_address_explanation());
    const restart = host.querySelector('a')!;
    expect(restart.textContent).toBe(m.buyer_orders_address_restart());
    const target = new URL(restart.getAttribute('href')!, 'https://site.test');
    expect(target.searchParams.has('cursor')).toBe(false);
    expect(target.searchParams.has('ordersCursor')).toBe(false);
    expect(target.searchParams.get('entitlementsCursor')).toBe(search.entitlementsCursor);
    show(viewer('A'));
    await tick();
    expect(reads).toHaveLength(beforeRepair);
    search = { cursor: 'cursor-address' };
    show(viewer('B'));
    await tick();
    const count = reads.length;
    act(() => obsoleteRetry());
    await tick();
    expect(reads).toHaveLength(count);
    await settle(reads.at(-1)!, response('B', 'wrong-cursor'));
    unknown();
    expect(host.textContent).toContain(m.error_heading());
    search = { cursor: 'locale-address' };
    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, response('B', 'locale-address', 'fr'));
    unknown();
    expect(host.textContent).toContain(m.error_heading());

    // Originating errors and successful pages both stay scoped when the UI locale changes.
    setLocale('fr', { reload: false });
    show(viewer('B'));
    unknown();
    await tick();
    expect(reads.at(-1)!.data).toEqual({ cursor: 'locale-address', locale: 'fr' });
    await settle(reads.at(-1)!, response('B', 'locale-address', 'fr'));
    expect(host.querySelector(`[href="/fr/orders/${id(2)}"]`)).not.toBeNull();
    setLocale('en', { reload: false });
    show(viewer('B'));
    absent('B');
    await tick();
    await act(async () => {
      reads.at(-1)!.reject(notFound());
    });
    await tick();
    unknown();
    expect(host.textContent).toContain(m.not_found_heading());
    search = { cursor: 'empty-later-page' };
    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, { ...response('B', 'empty-later-page'), page: { orders: [], next: null } });
    expect(host.textContent).toContain(m.orders_page_empty());
    expect(host.textContent).not.toContain(m.buyer_orders_address_heading());
    search = {};
    show(viewer('B'));
    await tick();
    await settle(reads.at(-1)!, { ...response('B'), page: { orders: [], next: null } });
    expect(host.textContent).toContain(m.orders_empty());
    expect(invalidate).not.toHaveBeenCalled();
    expect(router.history.location.href).toBe('/en/orders');
    expect(client.getQueryData(['orders'])).toEqual(response('FOREIGN').page);

    await act(async () => root!.unmount());
    root = createRoot(host);
    const beforeUnknownMount = reads.length;
    show({ state: 'unknown', csrfToken: null });
    absent('A'); // A retained private loader is not authority on a fresh, unknown browser mount.
    unknown();
    await tick();
    expect(reads).toHaveLength(beforeUnknownMount);
  } finally {
    if (root) await act(async () => root!.unmount());
    loader.mockRestore();
    address.mockRestore();
    read.mockRestore();
    invalidate.mockRestore();
    errorPage.mockRestore();
    client.clear();
    host.remove();
    setLocale('en', { reload: false });
  }
});
