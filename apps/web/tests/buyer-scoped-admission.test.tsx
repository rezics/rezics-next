import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { BuyerOrdersCurrentRead } from '../src/checkout/orders';
import type { BuyerEntitlementCurrentRead, BuyerEntitlementsCurrentRead } from '../src/checkout/entitlements';
import type { OfferPageData } from '../src/checkout/offer';
import type { OrderPageData } from '../src/checkout/order';
import type { ReconciliationIntent, ReconciliationResult } from '../src/checkout/order-reconcile';
import { mappedEntitlement, fixedEditionTerms } from '../src/kernel/fake/entitlements';
import { receiptStoryMoney } from '../src/kernel/fake/checkout';
import paid from '../src/kernel/recorded/order-paid.json';

// UNRUN: composed consumer regressions. Original acceptance, native and browser proof are deferred.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const scoped = await import('../src/kernel/viewer-exposure');
const exposure = await import('../src/kernel/exposure');
const orders = await import('../src/checkout/orders');
const entitlements = await import('../src/checkout/entitlements');
const reconciliation = await import('../src/checkout/order-reconcile');
const buttons = await import('@rezics/ui/shadcn/button');
const { OrdersCurrent } = await import('../src/checkout/orders-current');
const { EntitlementsCurrent, EntitlementCurrent } = await import('../src/checkout/entitlements-current');
const { OfferPage } = await import('../src/checkout/offer-page');
const { OrderPage } = await import('../src/checkout/order-page');
const { useBuyerCurrentOrigin } = await import('../src/checkout/buyer-current-origin');
const { AnonymousSessionContext } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const viewer = (subject = 'A', csrfToken: string | null = `csrf-${subject}`) => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => pending.resolve(value));
  await tick();
}
function history(subject = 'A', cursor: string | null = null): BuyerOrdersCurrentRead {
  return {
    sessionSubject: subject,
    requested: { cursor, locale: 'en' },
    page: {
      orders: [
        {
          ...paid.order,
          title: `Purchase ${subject}`,
          settlement: 'paid',
          offerRevision: 1,
          moneyUnit: null,
          taxBehavior: null,
          contentEdition: null,
        },
      ],
      next: null,
    },
  };
}
function benefits(subject = 'A'): BuyerEntitlementsCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', cursor: null, locale: 'en' },
    page: { kind: 'ready', data: { entitlements: [mappedEntitlement], next: null } },
  };
}
function detail(subject = 'A', recordId = mappedEntitlement.id): BuyerEntitlementCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'detail', id: recordId, locale: 'en' },
    page: { kind: 'ready', data: { ...mappedEntitlement, id: recordId } },
  };
}
const offer: OfferPageData = {
  id: id(1),
  revision: 7,
  title: 'Accepted edition',
  currency: 'usd',
  unitAmountMinor: 1200,
  state: 'active',
  price: '$12.00',
  taxBehavior: 'exclusive',
  moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
  idempotencyKey: id(2),
  subject: {
    subject: { id: fixedEditionTerms.targetSubjectId, title: 'Accepted subject', types: [] },
    cover: null,
    href: null,
  },
  benefit: { kind: 'mapped', terms: fixedEditionTerms },
};
function receipt(): OrderPageData {
  return {
    id: id(10),
    offerId: offer.id,
    title: 'Captured receipt',
    settlement: 'pending',
    entitlementId: mappedEntitlement.id,
    entitlement: { kind: 'current', active: true },
    canUseBenefit: true,
    canReconcile: true,
    createdAt: '2026-11-01T00:00:00Z',
    money: receiptStoryMoney,
    benefit: offer.benefit,
    subject: offer.subject,
  };
}
const status = (order: OrderPageData, settlement = order.settlement) => ({
  id: order.id,
  offerId: order.offerId,
  settlement,
});

async function mount(render: () => ReactNode, token: string | null = 'csrf-A', enroll = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['session'], viewer('A', token));
  client.setQueryData(['exposure', 'anonymous'], ['purchases']);
  // Prepare exactly the installed lifetime/key; there is deliberately no legacy viewer entry.
  const lifetime = scoped.viewerExposureLifetime(client);
  const release = enroll ? lifetime.subscribe(() => {}) : () => {};
  const admit = (admitted: readonly string[] = ['purchases'], subject?: string) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('No enrolled viewer');
    client.setQueryData(scoped.viewerExposureQuery(snapshot.observation).queryKey, {
      subject: subject ?? snapshot.observation.subject,
      admitted,
    });
  };
  const session = (subject = 'A', token: string | null = `csrf-${subject}`) => {
    client.setQueryData(['session'], viewer(subject, token));
    admit();
  };
  if (enroll) admit();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const show = () =>
    act(() =>
      flushSync(() =>
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>{render()}</QueryClientProvider>
          </StrictMode>,
        ),
      ),
    );
  show();
  await tick();
  return {
    client,
    host,
    admit,
    session,
    show,
    async close() {
      await act(async () => root.unmount());
      release();
      client.clear();
      host.remove();
    },
  };
}
const action = (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  if (!button) throw new Error(`Missing action ${label}`);
  return button;
};

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Actual scoped buyer admission enables acquisition history benefits and receipt continuation without legacy cache authority or loss of uncertain intent', async () => {
  const reads: ReturnType<typeof deferred<BuyerOrdersCurrentRead>>[] = [];
  const orderRead = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(() => {
    const next = deferred<BuyerOrdersCurrentRead>();
    reads.push(next);
    return next.promise;
  });
  const lists: ReturnType<typeof deferred<BuyerEntitlementsCurrentRead>>[] = [];
  const listRead = spyOn(entitlements, 'readBuyerEntitlementsCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementsCurrentRead>();
    lists.push(next);
    return next.promise;
  });
  const details: ReturnType<typeof deferred<BuyerEntitlementCurrentRead>>[] = [];
  const detailRead = spyOn(entitlements, 'readBuyerEntitlementCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementCurrentRead>();
    details.push(next);
    return next.promise;
  });
  // Verify the consumer independently consults each installed operation mapping.
  const admitted = spyOn(exposure, 'operationIsAdmitted');
  const h = await mount(() => (
    <>
      <OfferPage offer={offer} />
      <OrdersCurrent initial={history()} search={{}} locale="en" />
      <EntitlementsCurrent initial={benefits()} locale="en" />
      <EntitlementCurrent initial={detail()} locale="en" id={mappedEntitlement.id} />
    </>
  ));
  try {
    expect(h.client.getQueryData(['exposure', 'viewer'])).toBeUndefined();
    expect(action(h.host, m.offer_buy()).disabled).toBe(false);
    expect(h.host.textContent).toContain('Purchase A');
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    expect(reads).toHaveLength(0);
    expect(lists).toHaveLength(0);
    expect(details).toHaveLength(0);
    expect(new Set(admitted.mock.calls.map(([op]) => op))).toEqual(
      new Set(['order.create', 'order.list', 'entitlement.get']),
    );
    await act(async () => {
      h.client.setQueryData(['exposure', 'viewer'], ['purchases']); // Foreign legacy success grants nothing.
      h.admit(['purchases'], 'foreign');
    });
    expect(action(h.host, m.offer_buy()).disabled).toBe(true);
    expect(h.host.textContent).not.toContain('Purchase A');
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await act(async () => h.admit());
    await tick();
    const retained = action(h.host, m.offer_buy());
    // Observe A -> B -> A synchronously before any replacement React commit.
    act(() => {
      h.session('B');
      retained.click();
      h.session();
      retained.click();
    });
    h.show();
    await tick();
    expect(action(h.host, m.offer_buy()).disabled).toBe(false);
    // A late private page, including a genuine empty success, cannot become B's presentation.
    const oldOrder = reads.at(-1)!;
    const oldList = lists.at(-1)!;
    const oldDetail = details.at(-1)!;
    act(() => h.session('B'));
    h.show();
    await tick();
    await settle(oldOrder, { ...history(), page: { orders: [], next: null } });
    await settle(oldList, { ...benefits(), page: { kind: 'ready', data: { entitlements: [], next: null } } });
    await settle(oldDetail, detail());
    expect(h.host.textContent).not.toContain(m.orders_empty());
    expect(h.host.textContent).not.toContain(m.entitlements_empty());
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    // Same-read subject and address rejection apply to empty results too.
    await settle(reads.at(-1)!, { ...history('B', 'wrong-cursor'), page: { orders: [], next: null } });
    await settle(lists.at(-1)!, {
      ...benefits('B'),
      requested: { kind: 'list', cursor: null, locale: 'fr' },
      page: { kind: 'ready', data: { entitlements: [], next: null } },
    });
    await settle(details.at(-1)!, detail('B', id(99)));
    expect(h.host.textContent).not.toContain(m.orders_empty());
    expect(h.host.textContent).not.toContain(m.entitlements_empty());
    act(() => {
      h.session('B', null);
      h.session('B');
    });
    h.show();
    await tick();
    await settle(reads.at(-1)!, { ...history('B'), page: { orders: [], next: null } });
    await settle(lists.at(-1)!, { ...benefits('B'), page: { kind: 'ready', data: { entitlements: [], next: null } } });
    await settle(details.at(-1)!, detail('B'));
    expect(h.host.textContent).toContain(m.orders_empty());
    expect(h.host.textContent).toContain(m.entitlements_empty());
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    await act(async () => {
      h.client
        .getQueryCache()
        .find({ queryKey: ['session'], exact: true })!
        .setState({ status: 'error', error: new Error('unavailable with retained data') });
    });
    expect(action(h.host, m.offer_buy()).disabled).toBe(true);
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
  } finally {
    await h.close();
    orderRead.mockRestore();
    listRead.mockRestore();
    detailRead.mockRestore();
    admitted.mockRestore();
  }
});

test('Offer uncertainty retains exact consent through scoped refresh and rotation, while old handlers, fetch and JSON cannot navigate usable B', async () => {
  let observed = offer;
  const responses: (Response | Promise<Response>)[] = [];
  const calls: { body: unknown; csrf: string | null }[] = [];
  const send = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('manual');
    calls.push({ body: JSON.parse(String(init?.body)), csrf: new Headers(init?.headers).get('x-csrf-token') });
    return responses.shift()!;
  });
  const redirects: string[] = [];
  const assign = spyOn(window.location, 'assign').mockImplementation((url) => {
    redirects.push(String(url));
  });
  const h = await mount(() => <OfferPage offer={observed} />);
  try {
    const pending = deferred<Response>();
    responses.push(pending.promise);
    await act(async () => action(h.host, m.offer_buy()).click());
    const originalBody = calls[0]!.body;
    observed = { ...offer, title: 'Refreshed terms', revision: 99, idempotencyKey: id(99), price: '$99.00' };
    act(() => h.session('A', 'rotated-A'));
    h.show();
    await tick();
    expect(h.host.textContent).toContain(offer.price);
    expect(h.host.textContent).toContain(m.offer_terms_revision({ revision: String(offer.revision) }));
    expect(h.host.querySelector('article')!.dataset.idempotencyKey).toBe(offer.idempotencyKey);
    await settle(pending, Response.json({}, { status: 503 }));
    expect(calls).toHaveLength(1); // No automatic replay when the new exposure succeeds.
    await act(async () => h.admit([]));
    expect(action(h.host, m.offer_retry()).disabled).toBe(true);
    expect(h.host.querySelector('article')!.dataset.idempotencyKey).toBe(offer.idempotencyKey);
    await act(async () => h.admit());
    // An equivalent successful authoritative refresh gets a new observation without new consent.
    act(() => {
      const updatedAt = h.client.getQueryState(['session'])!.dataUpdatedAt;
      h.client.setQueryData(['session'], viewer('A', 'rotated-A'), { updatedAt: updatedAt + 1 });
      h.admit();
    });
    h.show();
    await tick();
    const oldRetry = action(h.host, m.offer_retry());
    act(() => {
      h.session('A', 'latest-A');
      oldRetry.click();
    });
    expect(calls).toHaveLength(1); // A fresh current episode must explicitly retry.
    h.show();
    await tick();
    responses.push(Response.json({}, { status: 503 }));
    await act(async () => action(h.host, m.offer_retry()).click());
    expect(calls[1]).toEqual({ body: originalBody, csrf: 'csrf-A' });
    const decoding = deferred<unknown>();
    responses.push(Object.assign(new Response(), { json: () => decoding.promise }));
    await act(async () => action(h.host, m.offer_retry()).click());
    // B can acquire before A finishes decoding. It gets its own current loader terms/key.
    act(() => h.session('B'));
    h.show();
    await tick();
    responses.push(Response.json({ checkoutUrl: 'https://checkout.stripe.com/B' }));
    await act(async () => action(h.host, m.offer_buy()).click());
    expect(calls.at(-1)).toEqual({
      body: { offerId: observed.id, expectedOfferRevision: 99, idempotencyKey: id(99) },
      csrf: 'csrf-B',
    });
    await settle(decoding, { checkoutUrl: 'https://checkout.stripe.com/late-A' });
    expect(redirects).toEqual(['https://checkout.stripe.com/B']);
    // A late fetch is fenced just as its late decoded body was.
    const fetching = deferred<Response>();
    responses.push(fetching.promise);
    act(() => h.session());
    h.show();
    await tick();
    await act(async () => action(h.host, m.offer_buy()).click());
    act(() => {
      h.session('B');
      h.session();
    });
    h.show();
    await tick();
    await settle(fetching, Response.json({ checkoutUrl: 'https://checkout.stripe.com/obsolete' }));
    expect(redirects).toEqual(['https://checkout.stripe.com/B']);
    expect(action(h.host, m.offer_buy()).disabled).toBe(false);
  } finally {
    await h.close();
    send.mockRestore();
    assign.mockRestore();
  }
});

test('Receipt scoped episodes retain uncertain reconciliation and the fifteen reads across authority/address ABA without granting access from paid', async () => {
  let order = receipt();
  const sends: { intent: ReconciliationIntent; token: string | null }[] = [];
  const replies: (ReconciliationResult | Promise<ReconciliationResult>)[] = [];
  const send = spyOn(reconciliation, 'requestOrderReconciliation').mockImplementation(async ({ data, headers }) => {
    sends.push({ intent: data, token: new Headers(headers).get('X-CSRF-Token') });
    return replies.shift() ?? { kind: 'unavailable' };
  });
  const reads: RequestInit[] = [];
  const responses: (Response | Promise<Response>)[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    reads.push(init!);
    return responses.shift() ?? Response.json(status(order));
  });
  const timers = new Map<number, () => void>();
  let nextTimer = -1;
  const nativeSet = globalThis.setTimeout,
    nativeClear = globalThis.clearTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 2_000) return nativeSet(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, () => run(...args));
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClear(id);
  }) as typeof clearTimeout);
  const callbacks = new Map<string, () => void>();
  const Button = buttons.Button;
  const button = spyOn(buttons, 'Button').mockImplementation((props) => {
    if (typeof props.children === 'string' && props.onClick)
      callbacks.set(props.children, () => props.onClick!({} as never));
    return <Button {...props} />;
  });
  const h = await mount(() => <OrderPage order={order} />);
  const advance = async () => {
    const next = timers.entries().next().value;
    if (!next) return;
    timers.delete(next[0]);
    await act(async () => next[1]());
    await tick();
  };
  const click = (label = m.order_reconcile_action()) => act(() => callbacks.get(label)!());
  try {
    const uncertain = deferred<ReconciliationResult>();
    replies.push(uncertain.promise);
    click();
    click();
    expect(sends).toHaveLength(1);
    const retired = callbacks.get(m.order_reconcile_action())!;
    const originalTimer = [...timers.values()][0]!;
    act(() => {
      h.session('A', 'rotated');
      retired();
      originalTimer();
    });
    h.show();
    await tick();
    expect(sends).toHaveLength(1);
    expect(reads).toHaveLength(0);
    await settle(uncertain, { kind: 'retry' });
    replies.push({ kind: 'queued', orderId: order.id, reconciliation: 'queued' });
    click(m.order_reconcile_retry());
    await tick();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.intent).toBe(sends[0]!.intent);
    expect(sends[1]!.token).toBe('csrf-A');
    expect(h.host.textContent).toContain(m.order_reconcile_queued());
    expect(h.host.textContent).not.toContain(m.order_entitlement_refresh()); // Enqueue did not change settlement.
    click();
    expect(sends).toHaveLength(2);
    const decoding = deferred<unknown>();
    responses.push(Object.assign(new Response(), { json: () => decoding.promise }));
    await advance();
    act(() => {
      h.admit([]);
      h.admit();
    });
    h.show();
    await tick();
    expect(reads[0]!.signal!.aborted).toBe(true);
    await settle(decoding, status(order, 'paid'));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    const fetching = deferred<Response>();
    responses.push(fetching.promise);
    await advance();
    act(() => h.session('B'));
    h.show();
    await tick();
    await advance(); // B remains usable while old A is unresolved.
    await settle(fetching, Response.json(status(order, 'failed')));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    // Independent native reconciliation admission changes do not authorize a benefit.
    order = { ...order, canReconcile: false };
    h.show();
    await tick();
    expect(h.host.querySelector(`[aria-label="${m.order_reconcile_action()}"]`)).toBeNull();
    order = { ...order, canReconcile: true };
    h.show();
    await tick();
    order = { ...order, offerId: id(42) };
    h.show();
    await tick();
    order = { ...order, offerId: offer.id };
    h.show();
    await tick();
    act(() => {
      h.session();
      h.session('B');
    });
    h.show();
    await tick();
    for (let i = 0; i < 18; i++) await advance();
    expect(reads).toHaveLength(15);
    expect(reads.every((read) => read.cache === 'no-store' && read.redirect === 'manual')).toBe(true);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_still_processing());
    order = { ...order, settlement: 'paid', canUseBenefit: false, entitlement: { kind: 'refresh' } };
    h.show();
    await tick();
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await advance();
    expect(reads).toHaveLength(15);
  } finally {
    await h.close();
    send.mockRestore();
    fetcher.mockRestore();
    timer.mockRestore();
    clear.mockRestore();
    button.mockRestore();
  }
});

test('Healthy current null-CSRF reads retain history and access, while every retired session receipt stays excluded', async () => {
  const histories: ReturnType<typeof deferred<BuyerOrdersCurrentRead>>[] = [];
  const lists: ReturnType<typeof deferred<BuyerEntitlementsCurrentRead>>[] = [];
  const details: ReturnType<typeof deferred<BuyerEntitlementCurrentRead>>[] = [];
  const readHistory = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(() => {
    const pending = deferred<BuyerOrdersCurrentRead>();
    histories.push(pending);
    return pending.promise;
  });
  const readList = spyOn(entitlements, 'readBuyerEntitlementsCurrent').mockImplementation(() => {
    const pending = deferred<BuyerEntitlementsCurrentRead>();
    lists.push(pending);
    return pending.promise;
  });
  const readDetail = spyOn(entitlements, 'readBuyerEntitlementCurrent').mockImplementation(() => {
    const pending = deferred<BuyerEntitlementCurrentRead>();
    details.push(pending);
    return pending.promise;
  });
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  let authority!: ReturnType<typeof useBuyerCurrentOrigin>;
  let order = { ...receipt(), settlement: 'paid' as const };
  let anonymous = false;
  function Probe() {
    authority = useBuyerCurrentOrigin('order.list', 'null-read');
    return null;
  }
  const h = await mount(
    () => (
      <AnonymousSessionContext.Provider value={anonymous}>
        <Probe />
        <OrdersCurrent initial={history()} search={{}} locale="en" />
        <EntitlementsCurrent initial={benefits()} locale="en" />
        <EntitlementCurrent initial={detail()} locale="en" id={mappedEntitlement.id} />
        <div data-receipt>
          <OrderPage order={order} />
        </div>
        <OfferPage offer={offer} />
      </AnonymousSessionContext.Provider>
    ),
    null,
  );
  try {
    expect(authority.origin.isCurrent()).toBe(true);
    expect(authority.origin.credential()).toBeNull();
    expect(h.host.textContent).toContain('Purchase A');
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    expect(action(h.host, m.offer_buy()).disabled).toBe(true);
    expect(action(h.host, m.order_reconcile_action()).disabled).toBe(true);
    expect(histories).toHaveLength(0); // The original loader receipt retains its own subject/address.
    const receiptRegion = h.host.querySelector('[data-receipt]')!;
    expect(receiptRegion.textContent).toContain(m.benefit_open_reader());
    const owner = authority.intent;
    for (const token of ['available', null, 'rotated', null]) {
      const retired = authority.origin;
      act(() => {
        h.session('A', token);
        expect(retired.isCurrent()).toBe(false);
      });
      h.show();
      await tick();
      expect(authority.origin.isCurrent()).toBe(true);
      expect(authority.intent).toBe(owner);
      expect(h.host.textContent).not.toContain('Purchase A');
      expect(receiptRegion.textContent).not.toContain(m.benefit_open_reader());
      await settle(histories.at(-1)!, history());
      await settle(lists.at(-1)!, benefits());
      await settle(details.at(-1)!, detail());
      expect(h.host.textContent).toContain('Purchase A');
      expect(h.host.textContent).toContain(m.benefit_open_reader());
      expect(h.client.getQueryCache().findAll({ queryKey: ['orders-current'] }).length).toBeLessThanOrEqual(1);
      expect(h.client.getQueryCache().findAll({ queryKey: ['buyer-entitlements-current'] }).length).toBeLessThanOrEqual(
        2,
      );
    }
    expect(histories).toHaveLength(4);
    expect(lists).toHaveLength(4);
    expect(details).toHaveLength(4);
    // A fresh native-shaped page owns new access; the retired initial receipt cannot rebind itself.
    order = { ...receipt(), settlement: 'paid' };
    h.show();
    await tick();
    expect(receiptRegion.textContent).toContain(m.benefit_open_reader());
    order = { ...order, entitlement: { kind: 'refresh' }, canUseBenefit: false };
    h.show();
    await tick();
    expect(action(h.host, m.order_refresh()).disabled).toBe(false);
    await act(async () => action(h.host, m.order_refresh()).click());
    expect(reload).toHaveBeenCalledTimes(1);
    // Removal with retained data and a later same-subject success is still a new read episode.
    const removed = authority.origin;
    act(() => h.client.removeQueries({ queryKey: ['session'], exact: true }));
    h.show();
    await tick();
    expect(removed.isCurrent()).toBe(false);
    expect(h.host.textContent).not.toContain('Purchase A');
    act(() => h.session('A', null));
    h.show();
    await tick();
    const late = histories.at(-1)!;
    await act(async () => h.admit(['purchases'], 'foreign'));
    await settle(late, history());
    expect(authority.origin.isCurrent()).toBe(false);
    expect(h.host.textContent).not.toContain('Purchase A');
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await act(async () => h.admit());
    anonymous = true;
    h.show();
    await tick();
    expect(authority.origin.isCurrent()).toBe(false);
    expect(h.host.textContent).not.toContain('Purchase A');
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
  } finally {
    await h.close();
    readHistory.mockRestore();
    readList.mockRestore();
    readDetail.mockRestore();
    reload.mockRestore();
  }
});

test('A successful subject and legacy exposure cannot grant a read before actual scoped enrollment and matching disclosure', async () => {
  let authority!: ReturnType<typeof useBuyerCurrentOrigin>;
  const observations: boolean[] = [];
  function Probe() {
    authority = useBuyerCurrentOrigin('order.get', 'enrollment');
    observations.push(authority.origin.isCurrent());
    return null;
  }
  const h = await mount(() => <Probe />, null, false);
  try {
    expect(observations[0]).toBe(false);
    expect(authority.origin.isCurrent()).toBe(false);
    await act(async () => h.client.setQueryData(['exposure', 'viewer'], ['purchases']));
    expect(authority.origin.isCurrent()).toBe(false);
    await act(async () => h.admit(['purchases'], 'foreign'));
    expect(authority.origin.isCurrent()).toBe(false);
    await act(async () => h.admit());
    h.show();
    await tick();
    expect(authority.origin.isCurrent()).toBe(true);
    // A malformed successful session is unavailable, even if the native exposure cache still matches.
    act(() => h.session('A', ''));
    h.show();
    await tick();
    expect(authority.state).toBe('unavailable');
    expect(authority.origin.isCurrent()).toBe(false);
    await act(async () => h.client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
    expect(authority.origin.isCurrent()).toBe(false);
  } finally {
    await h.close();
  }
});

test('Only a later deliberate action captures write credentials; null, rotation, refreshed operands and sender changes never replace an uncertain original', async () => {
  let observed = offer;
  let replacement: ((intent: ReconciliationIntent) => Promise<ReconciliationResult>) | undefined;
  let replacements = 0;
  const offerCalls: { body: unknown; token: string | null }[] = [];
  const reconcileCalls: { intent: ReconciliationIntent; token: string | null }[] = [];
  const purchase = deferred<Response>();
  const recovery = deferred<ReconciliationResult>();
  const send = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    offerCalls.push({ body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get('x-csrf-token') });
    return offerCalls.length === 1 ? purchase.promise : Response.json({}, { status: 503 });
  });
  const reconcile = spyOn(reconciliation, 'requestOrderReconciliation').mockImplementation(
    async ({ data, headers }) => {
      reconcileCalls.push({ intent: data, token: new Headers(headers).get('X-CSRF-Token') });
      return reconcileCalls.length === 1 ? recovery.promise : { kind: 'retry' };
    },
  );
  const callbacks = new Map<string, () => void>();
  const Button = buttons.Button;
  const button = spyOn(buttons, 'Button').mockImplementation((props) => {
    if (typeof props.children === 'string' && props.onClick)
      callbacks.set(props.children, () => props.onClick!({} as never));
    return <Button {...props} />;
  });
  let order = receipt();
  let provider: InstanceType<typeof QueryClient> | undefined;
  const render = () => (
    <>
      <OfferPage offer={observed} />
      <OrderPage order={order} checkout="canceled" {...(replacement ? { reconcile: replacement } : {})} />
    </>
  );
  const h = await mount(
    () => (provider ? <QueryClientProvider client={provider}>{render()}</QueryClientProvider> : render()),
    null,
  );
  let releaseProvider: (() => void) | undefined;
  const click = (label: string) => act(() => callbacks.get(label)!());
  try {
    expect(action(h.host, m.offer_buy()).disabled).toBe(true);
    expect(action(h.host, m.order_reconcile_action()).disabled).toBe(true);
    click(m.offer_buy()); // Deliberately exercise the dispatch guard as well as disabled controls.
    click(m.order_reconcile_action());
    expect(offerCalls).toHaveLength(0);
    expect(reconcileCalls).toHaveLength(0);
    observed = { ...offer, revision: 8, idempotencyKey: id(8) };
    act(() => h.session('A', 'first-deliberate-token'));
    h.show();
    await tick();
    click(m.offer_buy());
    click(m.offer_buy());
    click(m.order_reconcile_action());
    click(m.order_reconcile_action());
    expect(offerCalls).toHaveLength(1);
    expect(reconcileCalls).toHaveLength(1);
    expect(offerCalls[0]).toEqual({
      body: { offerId: offer.id, expectedOfferRevision: 8, idempotencyKey: id(8) },
      token: 'first-deliberate-token',
    });
    expect(reconcileCalls[0]!.token).toBe('first-deliberate-token');
    observed = { ...offer, revision: 99, idempotencyKey: id(99) };
    replacement = async () => {
      replacements++;
      return { kind: 'queued', orderId: order.id, reconciliation: 'queued' };
    };
    act(() => h.session('A', null));
    h.show();
    await tick();
    click(m.offer_retry());
    click(m.order_reconcile_retry());
    expect(offerCalls).toHaveLength(1); // The original sender is still pending across the remount.
    expect(reconcileCalls).toHaveLength(1);
    await settle(purchase, Response.json({}, { status: 503 }));
    await settle(recovery, { kind: 'retry' });
    for (const token of [null, 'later-token', null, 'first-deliberate-token']) {
      const oldBuy = callbacks.get(m.offer_retry())!;
      const oldReconcile = callbacks.get(m.order_reconcile_retry())!;
      const before = offerCalls.length;
      act(() => {
        // Include a synchronous token ABA before any replacement render.
        h.session('A', 'transient');
        h.session('A', token);
        oldBuy();
        oldReconcile();
      });
      expect(offerCalls).toHaveLength(before);
      expect(reconcileCalls).toHaveLength(before);
      h.show();
      await tick();
      expect(action(h.host, m.offer_retry()).disabled).toBe(false);
      expect(action(h.host, m.order_reconcile_retry()).disabled).toBe(false);
      click(m.offer_retry());
      click(m.order_reconcile_retry());
      await tick();
      expect(offerCalls).toHaveLength(before + 1);
      expect(offerCalls.at(-1)).toEqual(offerCalls[0]);
      expect(reconcileCalls.at(-1)!.intent).toBe(reconcileCalls[0]!.intent);
      expect(Object.isFrozen(reconcileCalls[0]!.intent)).toBe(true);
      expect(reconcileCalls.at(-1)!.token).toBe('first-deliberate-token');
      expect(replacements).toBe(0);
      expect(h.host.querySelector('article')!.dataset.idempotencyKey).toBe(id(8));
    }
    const stalePurchase = callbacks.get(m.offer_retry())!;
    const staleRecovery = callbacks.get(m.order_reconcile_retry())!;
    const before = offerCalls.length;
    // A new provider with the same subject cannot inherit an old provider's intent or pending receipts.
    provider = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    provider.setQueryData(['session'], viewer('A', null));
    const lifetime = scoped.viewerExposureLifetime(provider);
    releaseProvider = lifetime.subscribe(() => {});
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected enrolled replacement provider');
    provider.setQueryData(scoped.viewerExposureQuery(snapshot.observation).queryKey, {
      subject: 'A',
      admitted: ['purchases'],
    });
    h.show();
    await tick();
    act(() => {
      stalePurchase();
      staleRecovery();
    });
    expect(offerCalls).toHaveLength(before);
    expect(reconcileCalls).toHaveLength(before);
    expect(action(h.host, m.offer_buy()).disabled).toBe(true);
    expect(action(h.host, m.order_reconcile_action()).disabled).toBe(true);
    // Exact-address replacement also fences handlers retained from the replacement provider.
    provider.setQueryData(['session'], viewer('A', 'provider-token'));
    const current = lifetime.getSnapshot();
    if (current.state !== 'signed-in') throw new Error('Expected replacement observation');
    provider.setQueryData(scoped.viewerExposureQuery(current.observation).queryKey, {
      subject: 'A',
      admitted: ['purchases'],
    });
    h.show();
    await tick();
    const previousBuy = callbacks.get(m.offer_buy())!;
    const previousRecovery = callbacks.get(m.order_reconcile_action())!;
    observed = { ...observed, id: id(88), idempotencyKey: id(89) };
    order = { ...order, id: id(90) };
    h.show();
    await tick();
    act(() => {
      previousBuy();
      previousRecovery();
      stalePurchase();
      staleRecovery();
    });
    expect(offerCalls).toHaveLength(before);
    expect(reconcileCalls).toHaveLength(before);
    expect(replacements).toBe(0);
  } finally {
    await h.close();
    releaseProvider?.();
    provider?.clear();
    send.mockRestore();
    reconcile.mockRestore();
    button.mockRestore();
  }
});

test('Default null-CSRF order status polling and explicit access recovery remain reads and reject retired responses', async () => {
  const order = receipt();
  const replies: ReturnType<typeof deferred<Response>>[] = [];
  const reads: RequestInit[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`/orders/${order.id}/status`);
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).has('X-CSRF-Token')).toBe(false);
    reads.push(init!);
    const next = deferred<Response>();
    replies.push(next);
    return next.promise;
  });
  const timers = new Map<number, () => void>();
  let nextTimer = -1;
  const nativeSet = globalThis.setTimeout,
    nativeClear = globalThis.clearTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 2_000) return nativeSet(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, () => run(...args));
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClear(id);
  }) as typeof clearTimeout);
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  const h = await mount(() => <OrderPage order={order} />, null);
  const advance = () => {
    const next = timers.entries().next().value!;
    timers.delete(next[0]);
    act(() => {
      void next[1]();
    });
  };
  try {
    expect(action(h.host, m.order_reconcile_action()).disabled).toBe(true);
    advance();
    expect(reads).toHaveLength(1);
    act(() => {
      h.session('A', 'token');
      h.session('A', null);
    });
    h.show();
    await tick();
    expect(reads[0]!.signal!.aborted).toBe(true);
    await settle(replies[0]!, Response.json(status(order, 'paid')));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    advance();
    await settle(replies[1]!, Response.json(status(order, 'paid')));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_paid());
    expect(h.host.textContent).toContain(m.order_entitlement_refresh());
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    expect(action(h.host, m.order_refresh()).disabled).toBe(false);
    await act(async () => action(h.host, m.order_refresh()).click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(2);
    expect(timers.size).toBe(0);
  } finally {
    await h.close();
    fetcher.mockRestore();
    reload.mockRestore();
    timer.mockRestore();
    clear.mockRestore();
  }
});
