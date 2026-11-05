import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, startTransition, StrictMode, Suspense, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { BuyerOrdersCurrentRead } from '../src/checkout/orders';
import type { BuyerEntitlementCurrentRead, BuyerEntitlementsCurrentRead } from '../src/checkout/entitlements';
import type { OrderPageData } from '../src/checkout/order';
import type { ReconciliationIntent, ReconciliationResult } from '../src/checkout/order-reconcile';
import { mappedEntitlement, fixedEditionTerms } from '../src/kernel/fake/entitlements';
import { receiptStoryMoney } from '../src/kernel/fake/checkout';
import paid from '../src/kernel/recorded/order-paid.json';

// UNRUN: composed source regressions for the actual QueryClient observation boundary. Native,
// original acceptance and browser proof remain integration obligations at this launch boundary.
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
const orders = await import('../src/checkout/orders');
const entitlements = await import('../src/checkout/entitlements');
const reconciliation = await import('../src/checkout/order-reconcile');
const shell = await import('../src/shell/shell');
const listPresentation = await import('../src/checkout/entitlements-page');
const detailPresentation = await import('../src/checkout/entitlement-page');
const buttons = await import('@rezics/ui/shadcn/button');
const { OrdersCurrent } = await import('../src/checkout/orders-current');
const { EntitlementsCurrent, EntitlementCurrent } = await import('../src/checkout/entitlements-current');
const { OrderPage } = await import('../src/checkout/order-page');
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function history(subject = 'A', cursor: string | null = null, locale = 'en'): BuyerOrdersCurrentRead {
  return {
    sessionSubject: subject,
    requested: { cursor, locale },
    page: {
      orders: [
        {
          ...paid.order,
          id: id(subject === 'A' ? 1 : 2),
          title: `Purchase ${subject}`,
          settlement: 'paid',
          offerRevision: 1,
          currency: 'usd',
          unitAmountMinor: 1200,
          moneyUnit: null,
          taxBehavior: null,
          taxCode: 'txcd_10302000',
          amountTaxMinor: null,
          contentEdition: null,
        },
      ],
      next: `next-${subject}`,
    },
  };
}
function benefits(subject = 'A', cursor: string | null = null, locale = 'en'): BuyerEntitlementsCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'list', cursor, locale },
    page: { kind: 'ready', data: { entitlements: [mappedEntitlement], next: null } },
  };
}
function detail(subject = 'A', recordId = mappedEntitlement.id, locale = 'en'): BuyerEntitlementCurrentRead {
  return {
    sessionSubject: subject,
    requested: { kind: 'detail', id: recordId, locale },
    page: { kind: 'ready', data: { ...mappedEntitlement, id: recordId } },
  };
}
function receipt(orderId = id(1), settlement: OrderPageData['settlement'] = 'pending'): OrderPageData {
  return {
    id: orderId,
    offerId: id(10),
    title: 'Captured receipt',
    settlement,
    entitlementId: mappedEntitlement.id,
    entitlement: { kind: 'current', active: true },
    canUseBenefit: true,
    canReconcile: true,
    createdAt: '2026-11-01T00:00:00Z',
    money: receiptStoryMoney,
    benefit: { kind: 'mapped', terms: fixedEditionTerms },
    subject: { subject: { id: id(20), title: 'Captured receipt', types: [] }, cover: null, href: null },
  };
}
const status = (order: OrderPageData, settlement = order.settlement) => ({
  id: order.id,
  offerId: order.offerId,
  settlement,
});
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const settle = async <T,>(work: ReturnType<typeof deferred<T>>, value: T) => {
  await act(async () => work.resolve(value));
  await tick();
};

async function mount(render: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['session'], viewer());
  client.setQueryData(['exposure', 'viewer'], ['purchases']);
  client.setQueryData(['exposure', 'anonymous'], []);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>{render()}</QueryClientProvider>
    </StrictMode>
  );
  const show = () => act(() => flushSync(() => root.render(tree())));
  show();
  await tick();
  return {
    client,
    host,
    show,
    transition: () => act(() => startTransition(() => root.render(tree()))),
    async close() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
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

test('Buyer history benefits and receipt continuations retire observed viewer admission or address replacement including precommit ABA without replenishing polling allowance', async () => {
  const orderReads: ReturnType<typeof deferred<BuyerOrdersCurrentRead>>[] = [];
  const listReads: ReturnType<typeof deferred<BuyerEntitlementsCurrentRead>>[] = [];
  const detailReads: ReturnType<typeof deferred<BuyerEntitlementCurrentRead>>[] = [];
  const orderRead = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(() => {
    const next = deferred<BuyerOrdersCurrentRead>();
    orderReads.push(next);
    return next.promise;
  });
  const listRead = spyOn(entitlements, 'readBuyerEntitlementsCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementsCurrentRead>();
    listReads.push(next);
    return next.promise;
  });
  const detailRead = spyOn(entitlements, 'readBuyerEntitlementCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementCurrentRead>();
    detailReads.push(next);
    return next.promise;
  });
  let orderRetry: (() => void) | undefined;
  let listRetry: (() => void) | undefined;
  let detailRetry: (() => void) | undefined;
  const ErrorPage = shell.ErrorPage;
  const errorPage = spyOn(shell, 'ErrorPage').mockImplementation((props) => {
    orderRetry = props?.onRetry;
    return <ErrorPage {...props} />;
  });
  const List = listPresentation.EntitlementsPage;
  const listPage = spyOn(listPresentation, 'EntitlementsPage').mockImplementation((props) => {
    listRetry = props.retry;
    return <List {...props} />;
  });
  const Detail = detailPresentation.EntitlementPage;
  const detailPage = spyOn(detailPresentation, 'EntitlementPage').mockImplementation((props) => {
    detailRetry = props.retry;
    return <Detail {...props} />;
  });
  let cursor: string | undefined;
  let recordId = mappedEntitlement.id;
  let suspended = false;
  const never = new Promise(() => {});
  function HoldCommit() {
    if (suspended) throw never;
    return null;
  }
  const h = await mount(() => (
    <Suspense fallback="Preparing">
      <OrdersCurrent initial={history()} search={cursor ? { cursor } : {}} locale="en" />
      <EntitlementsCurrent initial={benefits()} cursor={cursor} locale="en" />
      <EntitlementCurrent initial={detail()} id={recordId} locale="en" />
      <HoldCommit />
    </Suspense>
  ));
  try {
    expect(h.host.textContent).toContain('Purchase A');
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    expect(listReads).toHaveLength(0);
    expect(detailReads).toHaveLength(0);
    await act(async () => orderReads[0]!.reject(new Error('explicit retry')));
    await tick();
    const retained = [orderRetry!, listRetry!, detailRetry!];
    const counts = [orderReads.length, listReads.length, detailReads.length];
    act(() => {
      // Both replacements happen while React still displays A, including an old error's retry.
      h.client.setQueryData(['session'], viewer('B'));
      h.client.setQueryData(['session'], viewer('A'));
      retained.forEach((retry) => retry());
      expect([orderReads.length, listReads.length, detailReads.length]).toEqual(counts);
    });
    h.show();
    await tick();
    expect(h.host.textContent).not.toContain('Purchase A');
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    expect(listReads.length).toBeGreaterThan(counts[1]!);
    expect(detailReads.length).toBeGreaterThan(counts[2]!);

    // B's healthy read stays independent of late A successes, errors and completion bookkeeping.
    const oldList = listReads.at(-1)!;
    const oldDetail = detailReads.at(-1)!;
    act(() => h.client.setQueryData(['session'], viewer('B')));
    h.show();
    await tick();
    await settle(orderReads.at(-1)!, history('B'));
    await settle(listReads.at(-1)!, {
      ...benefits('B'),
      page: { kind: 'ready', data: { entitlements: [], next: null } },
    });
    await settle(detailReads.at(-1)!, detail('B'));
    await settle(oldList, benefits('A'));
    await act(async () => oldDetail.reject(new Error('late A failure')));
    await tick();
    expect(h.host.textContent).toContain('Purchase B');
    expect(h.host.textContent).not.toContain('Purchase A');
    const oldCallbacks = [listRetry!, detailRetry!];
    act(() => {
      h.client.setQueryData(['exposure', 'viewer'], []);
      h.client.setQueryData(['exposure', 'viewer'], ['purchases']);
      oldCallbacks.forEach((retry) => retry());
    });
    h.show();
    await tick();
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await settle(orderReads.at(-1)!, history('B'));
    await settle(listReads.at(-1)!, benefits('B'));
    await settle(detailReads.at(-1)!, detail('B'));

    // A rendered replacement can suspend before commit; returning to the address cannot revive callbacks.
    const beforeAddress = [listRetry!, detailRetry!];
    cursor = 'different';
    recordId = id(99);
    suspended = true;
    h.transition();
    const dispatched = [listReads.length, detailReads.length];
    act(() => beforeAddress.forEach((retry) => retry()));
    expect([listReads.length, detailReads.length]).toEqual(dispatched);
    cursor = undefined;
    recordId = mappedEntitlement.id;
    suspended = false;
    h.show();
    await tick();
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await settle(orderReads.at(-1)!, history('B'));
    await settle(listReads.at(-1)!, benefits('B'));
    await settle(detailReads.at(-1)!, detail('B'));
    expect(h.host.textContent).toContain(m.benefit_open_reader());
  } finally {
    await h.close();
    orderRead.mockRestore();
    listRead.mockRestore();
    detailRead.mockRestore();
    errorPage.mockRestore();
    listPage.mockRestore();
    detailPage.mockRestore();
  }
});

test('Prepared list/detail provenance rejects wrong viewer address locale and empty pages, then recovers without reusing a retired loader', async () => {
  const listReads: ReturnType<typeof deferred<BuyerEntitlementsCurrentRead>>[] = [];
  const detailReads: ReturnType<typeof deferred<BuyerEntitlementCurrentRead>>[] = [];
  const orderReads: ReturnType<typeof deferred<BuyerOrdersCurrentRead>>[] = [];
  const listRead = spyOn(entitlements, 'readBuyerEntitlementsCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementsCurrentRead>();
    listReads.push(next);
    return next.promise;
  });
  const detailRead = spyOn(entitlements, 'readBuyerEntitlementCurrent').mockImplementation(() => {
    const next = deferred<BuyerEntitlementCurrentRead>();
    detailReads.push(next);
    return next.promise;
  });
  const orderRead = spyOn(orders, 'readBuyerOrdersCurrent').mockImplementation(() => {
    const next = deferred<BuyerOrdersCurrentRead>();
    orderReads.push(next);
    return next.promise;
  });
  const h = await mount(() => (
    <>
      <OrdersCurrent initial={history('foreign')} search={{}} locale="en" />
      <EntitlementsCurrent initial={benefits('foreign')} locale="en" />
      <EntitlementCurrent initial={detail('foreign')} id={mappedEntitlement.id} locale="en" />
    </>
  ));
  try {
    for (const wrong of ['viewer', 'cursor', 'locale'] as const) {
      await settle(listReads.at(-1)!, {
        ...benefits(
          wrong === 'viewer' ? 'foreign' : 'A',
          wrong === 'cursor' ? 'wrong' : null,
          wrong === 'locale' ? 'fr' : 'en',
        ),
        page: { kind: 'ready', data: { entitlements: [], next: null } },
      });
      await settle(
        detailReads.at(-1)!,
        detail(
          wrong === 'viewer' ? 'foreign' : 'A',
          wrong === 'cursor' ? id(99) : mappedEntitlement.id,
          wrong === 'locale' ? 'fr' : 'en',
        ),
      );
      await settle(orderReads.at(-1)!, {
        ...history(
          wrong === 'viewer' ? 'foreign' : 'A',
          wrong === 'cursor' ? 'wrong' : null,
          wrong === 'locale' ? 'fr' : 'en',
        ),
        page: { orders: [], next: null },
      });
      expect(h.host.textContent).not.toContain(m.orders_empty());
      expect(h.host.textContent).not.toContain(m.entitlements_empty());
      expect(h.host.textContent).not.toContain(m.benefit_open_reader());
      act(() => {
        h.client.setQueryData(['session'], viewer('A', null));
        h.client.setQueryData(['session'], viewer());
      });
      h.show();
      await tick();
    }
    await settle(listReads.at(-1)!, { ...benefits(), page: { kind: 'ready', data: { entitlements: [], next: null } } });
    await settle(detailReads.at(-1)!, detail());
    await settle(orderReads.at(-1)!, { ...history(), page: { orders: [], next: null } });
    expect(h.host.textContent).toContain(m.orders_empty());
    expect(h.host.textContent).toContain(m.entitlements_empty());
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    // A failed query with retained signed-in data is a real loss, even if repaired before commit.
    act(() => {
      const session = h.client.getQueryCache().find({ queryKey: ['session'], exact: true })!;
      session.setState({ status: 'error', error: new Error('session unavailable') });
      h.client.setQueryData(['session'], viewer());
    });
    h.show();
    await tick();
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
  } finally {
    await h.close();
    listRead.mockRestore();
    detailRead.mockRestore();
    orderRead.mockRestore();
  }
});

test('Receipt retained callbacks fence late fetch and JSON, preserve rotated uncertain reconciliation and the fifteen-read allowance', async () => {
  let order = receipt();
  const Button = buttons.Button;
  const callbacks = new Map<string, () => void>();
  const button = spyOn(buttons, 'Button').mockImplementation((props) => {
    if (typeof props.children === 'string' && props.onClick)
      callbacks.set(props.children, () => props.onClick!({} as never));
    return <Button {...props} />;
  });
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
  let now = 0,
    nextTimer = -1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const nativeSet = globalThis.setTimeout,
    nativeClear = globalThis.clearTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 2_000) return nativeSet(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, { at: now + delay, run: () => run(...args) });
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClear(id);
  }) as typeof clearTimeout);
  const reload = spyOn(window.location, 'reload').mockImplementation(() => {});
  let suspended = false;
  const never = new Promise(() => {});
  function HoldCommit() {
    if (suspended) throw never;
    return null;
  }
  const h = await mount(() => (
    <Suspense fallback="Preparing">
      <OrderPage order={order} />
      <HoldCommit />
    </Suspense>
  ));
  const advance = async (milliseconds = 2_000) => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      await act(async () => next[1].run());
    }
    now = end;
  };
  const click = (label = m.order_reconcile_action()) => act(() => callbacks.get(label)!());
  try {
    const addressCallback = callbacks.get(m.order_reconcile_action())!;
    const addressTimer = [...timers.values()][0]!.run;
    const original = order;
    order = { ...order, offerId: id(11) };
    suspended = true;
    h.transition();
    act(() => {
      addressCallback();
      addressTimer();
    });
    expect(sends).toHaveLength(0);
    expect(reads).toHaveLength(0);
    order = original;
    suspended = false;
    h.show();
    await tick();
    const retiredEnqueue = deferred<ReconciliationResult>();
    replies.push(retiredEnqueue.promise);
    click();
    await tick();
    expect(sends).toHaveLength(1);
    const decoding = deferred<unknown>();
    responses.push(Object.assign(new Response(), { json: () => decoding.promise }));
    const oldTimer = [...timers.values()][0]!.run;
    await advance();
    const oldReconcile = callbacks.get(m.order_reconcile_action())!;
    act(() => {
      h.client.setQueryData(['session'], viewer('B'));
      h.client.setQueryData(['session'], viewer());
      oldReconcile();
      oldTimer();
      expect(reads[0]!.signal!.aborted).toBe(true);
      expect(reads).toHaveLength(1);
      expect(sends).toHaveLength(1);
    });
    h.show();
    await tick();
    const fetching = deferred<Response>();
    responses.push(fetching.promise);
    await advance();
    act(() => h.client.setQueryData(['session'], viewer('B')));
    order = receipt(id(1));
    h.show();
    await tick();
    await advance(); // B works while both old continuations are unresolved.
    await settle(decoding, status(order, 'paid'));
    await settle(fetching, Response.json(status(order, 'failed')));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    expect(h.host.textContent).not.toContain(m.order_entitlement_refresh());

    const uncertain = deferred<ReconciliationResult>();
    replies.push(uncertain.promise);
    click();
    click();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.intent.idempotencyKey).not.toBe(sends[0]!.intent.idempotencyKey);
    await settle(retiredEnqueue, { kind: 'queued', orderId: order.id, reconciliation: 'queued' });
    expect(h.host.textContent).toContain(m.order_reconcile_refreshing());
    expect(h.host.textContent).not.toContain(m.order_reconcile_queued());
    expect(h.host.textContent).not.toContain(m.order_entitlement_refresh());
    act(() => h.client.setQueryData(['session'], viewer('B', 'rotated-B')));
    await settle(uncertain, { kind: 'retry' });
    replies.push({ kind: 'queued', orderId: order.id, reconciliation: 'queued' });
    click(m.order_reconcile_retry());
    await tick();
    expect(sends).toHaveLength(3);
    expect(sends[2]!.intent).toEqual(sends[1]!.intent);
    expect(sends[2]!.token).toBe('csrf-B');
    const oldReload = callbacks.get(m.order_refresh())!;
    const accepted = callbacks.get(m.order_reconcile_action())!;
    act(() => accepted());
    await tick();
    expect(sends).toHaveLength(3);
    expect(h.host.textContent).toContain(m.order_reconcile_queued());
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    act(() => {
      const exposure = h.client.getQueryCache().find({ queryKey: ['exposure', 'viewer'], exact: true })!;
      exposure.setState({ status: 'error', error: new Error('admission failed') });
      h.client.setQueryData(['exposure', 'viewer'], ['purchases']);
      oldReload();
      accepted();
      expect(reload).not.toHaveBeenCalled();
      expect(sends).toHaveLength(3);
    });
    h.show();
    await tick();
    click();
    await tick();
    expect(sends).toHaveLength(3); // Accepted enqueue is retained when only its refresh lifetime is replaced.
    await advance(60_000);
    expect(reads).toHaveLength(15);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_still_processing());
    act(() => {
      h.client.setQueryData(['session'], viewer());
      h.client.setQueryData(['session'], viewer('B'));
    });
    setLocale('fr', { reload: false });
    h.show();
    await tick();
    setLocale('en', { reload: false });
    h.show();
    await tick();
    await advance(60_000);
    expect(reads).toHaveLength(15);
    order = receipt(id(2));
    h.show();
    await tick();
    await advance();
    expect(reads).toHaveLength(16);
    expect(reads.every((read) => read.cache === 'no-store' && read.redirect === 'manual')).toBe(true);
    order = receipt(id(2), 'paid');
    h.show();
    await tick();
    expect(h.host.textContent).toContain(m.benefit_open_reader());
  } finally {
    await h.close();
    button.mockRestore();
    send.mockRestore();
    fetcher.mockRestore();
    timer.mockRestore();
    clear.mockRestore();
    reload.mockRestore();
    setLocale('en', { reload: false });
  }
});
