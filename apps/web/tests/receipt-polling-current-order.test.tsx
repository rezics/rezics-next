import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { OrderPageData } from '../src/checkout/order';
import type { ReconciliationIntent, ReconciliationResult } from '../src/checkout/order-reconcile';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';
import { receiptStoryMoney } from '../src/kernel/fake/checkout';
import { m } from '../src/paraglide/messages.js';

let viewer: { state: 'unknown' | 'signed-in' | 'signed-out'; subject?: string | null; csrfToken: string | null };
let admitted: boolean;
let accessRead: (input: { data: { id: string; locale: string } }) => Promise<OrderPageData> = async () => {
  throw new Error('No current Access recovery read configured');
};
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/query', () => ({ useSession: () => viewer }));
mock.module('../src/kernel/exposure', () => ({ useOperation: () => admitted, Exposure: () => null }));
mock.module('../src/checkout/order', () => ({ readOrder: (input: { data: { id: string; locale: string } }) => accessRead(input) }));

const firstId = '019a1b2c-3d4e-7f00-8a00-5b0000000061';
const secondId = '019a1b2c-3d4e-7f00-8a00-5b0000000062';
function receipt(id = firstId, settlement: OrderPageData['settlement'] = 'pending'): OrderPageData {
  return {
    id,
    offerId: id === firstId ? '019a1b2c-3d4e-7f00-8a00-5b0000000071' : '019a1b2c-3d4e-7f00-8a00-5b0000000072',
    title: `Captured ${id}`,
    subject: { subject: { id, title: `Captured ${id}`, types: [] }, cover: null, href: null },
    settlement,
    entitlementId: null,
    entitlement: { kind: 'current', active: true },
    canUseBenefit: true,
    canReconcile: true,
    createdAt: '2026-11-01T00:00:00Z',
    money: receiptStoryMoney,
    benefit: { kind: 'mapped', terms: fixedEditionTerms },
  };
}
const status = (order: OrderPageData, settlement = order.settlement) => ({
  id: order.id,
  offerId: order.offerId,
  settlement,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

// Authored UNRUN for integration. Only session/admission inputs and operation transports are substituted;
// assertions exercise the shipped OrderPage, receipt/access presentation and actual user controls.
async function mount(initial = receipt(), checkout?: 'canceled' | 'success') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://rezics.test/en/orders/${initial.id}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  viewer = { state: 'signed-in', subject: 'buyer-one', csrfToken: 'csrf' };
  admitted = true;
  const { createRoot } = await import('react-dom/client');
  const { OrderPage } = await import('../src/checkout/order-page');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let order = initial;
  let unmounted = false;
  const reads: Array<{ url: string; init: RequestInit }> = [];
  const responses: Array<Response | Promise<Response>> = [];
  const intents: ReconciliationIntent[] = [];
  const reconciliations: Array<ReconciliationResult | Promise<ReconciliationResult>> = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    reads.push({ url: String(input), init: init! });
    return responses.shift() ?? Response.json(status(order));
  });
  const reconcile = async (intent: ReconciliationIntent) => {
    intents.push(intent);
    return reconciliations.shift() ?? { kind: 'unavailable' as const };
  };
  // Advance the public two-second cadence without wall-clock sleeps or running services.
  let now = 0;
  let nextTimer = -1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 2_000) return nativeSetTimeout(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, { at: now + delay, run: () => run(...args) });
    return id;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClearTimeout(id);
  }) as typeof clearTimeout);
  const render = async (next = order, returned = checkout) => {
    order = next;
    checkout = returned;
    await act(async () =>
      root.render(<OrderPage order={order} {...(checkout ? { checkout } : {})} reconcile={reconcile} />),
    );
  };
  const advance = async (milliseconds = 2_000) => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      await act(async () => {
        next[1].run();
      });
    }
    now = end;
  };
  const click = async () => {
    const section = [...host.querySelectorAll('section')].find(
      (element) => element.getAttribute('aria-label') === m.order_reconcile_action(),
    );
    const button = section?.querySelector('button');
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    unmounted = true;
  };
  await render();
  return {
    host,
    reads,
    responses,
    intents,
    reconciliations,
    render,
    advance,
    click,
    unmount,
    async close() {
      if (!unmounted) await unmount();
      fetcher.mockRestore();
      timerSpy.mockRestore();
      clearSpy.mockRestore();
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Receipt polling and explicit reconciliation remain bound to the current order and admitted session across navigation and late responses', async () => {
  const h = await mount();
  try {
    const decoding = deferred<unknown>();
    h.responses.push(Object.assign(new Response(), { json: () => decoding.promise }));
    await h.advance(1_999);
    expect(h.reads).toHaveLength(0);
    await h.advance(1);
    expect(h.reads).toHaveLength(1);
    await h.advance(20_000);
    expect(h.reads).toHaveLength(1); // JSON decoding is still the same non-overlapping read.
    const old = h.reads[0]!;
    expect(old.init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
    expect(old.init.signal).toBeInstanceOf(AbortSignal);
    const next = receipt(secondId);
    await h.render(next);
    expect(old.init.signal!.aborted).toBe(true);
    await act(async () => decoding.resolve(status(receipt(), 'paid')));
    expect(h.host.textContent).toContain(next.title);
    expect(h.host.textContent).not.toContain(receipt().title);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    expect(h.host.textContent).toContain(m.order_entitlement_active());
    h.responses.push(Response.json(status(next, 'paid')));
    await h.advance();
    expect(h.reads[1]!.url).toBe(`/orders/${secondId}/status`);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_paid());
    expect(h.host.textContent).toContain(m.order_entitlement_refresh());
    expect(h.host.textContent).toContain('$12.00');
    expect(h.host.textContent).toContain(fixedEditionTerms.source.licence);
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    admitted = false;
    await h.render();
    admitted = true;
    await h.render();
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_paid());
    expect(h.host.textContent).toContain(m.order_entitlement_refresh());
    await h.advance(60_000);
    expect(h.reads).toHaveLength(2);
    // Only a newly loaded current-access result can restore the reader link.
    await h.render(receipt(secondId, 'paid'));
    expect(h.host.textContent).toContain(m.benefit_open_reader());
  } finally {
    await h.close();
  }
});

test('Observed session/admission loss and unmount abort private reads and reject both late fetch and JSON completions', async () => {
  const h = await mount();
  try {
    for (const boundary of ['unknown', 'signed-out', 'viewer', 'admission', 'unmount'] as const) {
      const decoding = deferred<unknown>();
      const fetching = deferred<Response>();
      h.responses.push(
        boundary === 'signed-out' ? fetching.promise : Object.assign(new Response(), { json: () => decoding.promise }),
      );
      await h.advance();
      const read = h.reads.at(-1)!;
      const count = h.reads.length;
      if (boundary === 'unmount') await h.unmount();
      else {
        if (boundary === 'admission') admitted = false;
        else if (boundary === 'viewer') viewer = { ...viewer, subject: 'buyer-two' };
        else viewer = { state: boundary, subject: null, csrfToken: null };
        await h.render();
      }
      expect(read.init.signal!.aborted).toBe(true);
      await act(async () => {
        fetching.resolve(Response.json(status(receipt(), 'paid')));
        decoding.resolve(status(receipt(), 'paid'));
      });
      if (boundary === 'viewer') {
        // The new viewer may start its own admitted read; retire it before checking no further IO.
        admitted = false;
        await h.render();
      }
      await h.advance(60_000);
      expect(h.reads).toHaveLength(count);
      expect(h.intents).toHaveLength(0);
      if (boundary !== 'unmount') {
        expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
        expect(h.host.textContent).not.toContain(m.order_entitlement_refresh());
        viewer = { state: 'signed-in', subject: 'buyer-one', csrfToken: 'csrf' };
        admitted = true;
        await h.render();
      }
    }
  } finally {
    await h.close();
  }
});

test('Unobserved or unadmitted sessions preserve loader HTML without private status IO or reconciliation', async () => {
  const h = await mount(receipt(firstId, 'paid'));
  try {
    for (const state of ['unknown', 'signed-out', 'signed-in'] as const) {
      viewer = { state, csrfToken: null };
      admitted = state !== 'signed-in';
      await h.render(receipt(firstId, 'paid'));
      expect(h.host.querySelector('h1')!.textContent).toBe(m.order_paid());
      expect(h.host.textContent).toContain('$12.96');
      expect(h.host.querySelector('section[aria-label] button')).toBeNull();
      await h.render(receipt());
      await h.advance(60_000);
    }
    expect(h.reads).toHaveLength(0);
    expect(h.intents).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test('Malformed or mismatched settlement bodies cannot replace captured receipt identity or authorize access', async () => {
  const order = receipt();
  const h = await mount(order);
  try {
    for (const body of [
      null,
      [],
      {},
      { settlement: 'paid', offerId: order.offerId },
      status(receipt(secondId), 'paid'),
      { ...status(order, 'paid'), offerId: secondId },
      { ...status(order), settlement: 'invented' },
    ]) {
      h.responses.push(Response.json(body));
      await h.advance();
      expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
      expect(h.host.textContent).toContain(order.title);
      expect(h.host.textContent).toContain(m.order_entitlement_active());
      expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    }
    h.responses.push(
      Response.json({
        ...status(order, 'paid'),
        entitlement: { kind: 'current', active: true },
        canUseBenefit: true,
        title: 'Injected',
        money: { unitAmountMinor: 1 },
      }),
    );
    await h.advance();
    expect(h.host.textContent).toContain(m.order_entitlement_refresh());
    expect(h.host.textContent).toContain(order.title);
    expect(h.host.textContent).toContain('$12.00');
    expect(h.host.textContent).not.toContain('Injected');
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    const { applyOrderStatus } = await import('../src/checkout/order-page');
    expect(applyOrderStatus(order, 'paid', secondId)).toBe(order);
  } finally {
    await h.close();
  }
});

test('The fifteen-read allowance survives rerenders, open-settlement transitions and admission loss, then resets for a new order', async () => {
  const h = await mount();
  try {
    for (let read = 0; read < 15; read++) {
      h.responses.push(Response.json(status(receipt(), read % 2 ? 'pending' : 'unknown')));
      await h.advance();
      await h.render();
      if (read === 5) {
        admitted = false;
        await h.render();
        await h.advance(60_000);
        admitted = true;
        await h.render();
      }
    }
    expect(h.reads).toHaveLength(15);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_still_processing());
    await h.render({ ...receipt() });
    await h.advance(60_000);
    expect(h.reads).toHaveLength(15);
    await h.render(receipt(secondId));
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_pending());
    await h.advance();
    expect(h.reads).toHaveLength(16);
  } finally {
    await h.close();
  }
});

test('Explicit reconciliation retains retry identity, suppresses duplicates and cannot queue a later order or session', async () => {
  const h = await mount(receipt(firstId, 'paid'));
  try {
    const lost = deferred<ReconciliationResult>();
    h.reconciliations.push(lost.promise);
    await h.click();
    await h.click();
    expect(h.intents).toHaveLength(1);
    await act(async () => lost.resolve({ kind: 'retry' }));
    const queued = deferred<ReconciliationResult>();
    h.reconciliations.push(queued.promise);
    await h.click();
    expect(h.intents).toHaveLength(2);
    expect(h.intents[1]).toEqual(h.intents[0]);
    await h.render(receipt(secondId, 'paid'));
    await act(async () => queued.resolve({ kind: 'queued', orderId: firstId, reconciliation: 'queued' }));
    expect(h.host.textContent).not.toContain(m.order_reconcile_queued());
    expect(h.host.textContent).toContain(m.order_entitlement_active());
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    for (const boundary of ['unknown', 'signed-out', 'viewer', 'admission', 'reconcile-admission'] as const) {
      viewer = { state: 'signed-in', subject: 'buyer-one', csrfToken: 'csrf' };
      admitted = true;
      await h.render(receipt(secondId, 'paid'));
      const old = deferred<ReconciliationResult>();
      h.reconciliations.push(old.promise);
      await h.click();
      expect(h.intents.at(-1)!.orderId).toBe(secondId);
      expect(h.intents.at(-1)!.idempotencyKey).not.toBe(h.intents[0]!.idempotencyKey);
      if (boundary === 'viewer') viewer = { ...viewer, subject: 'buyer-two' };
      else if (boundary === 'admission') admitted = false;
      else if (boundary !== 'reconcile-admission') viewer = { state: boundary, csrfToken: null };
      await h.render({ ...receipt(secondId, 'paid'), canReconcile: boundary !== 'reconcile-admission' });
      await act(async () => old.resolve({ kind: 'queued', orderId: secondId, reconciliation: 'queued' }));
      expect(h.host.textContent).not.toContain(m.order_reconcile_queued());
      expect(h.host.textContent).not.toContain(m.order_entitlement_refresh());
    }
    await h.advance(60_000);
    expect(h.reads).toHaveLength(0);
    admitted = true;
    await h.render(receipt(secondId, 'paid'));
    h.reconciliations.push({ kind: 'queued', orderId: secondId, reconciliation: 'queued' });
    await h.click();
    await h.click();
    expect(h.host.textContent).toContain(m.order_reconcile_queued());
    expect(h.host.textContent).toContain(m.order_entitlement_refresh());
    expect(h.host.textContent).not.toContain(m.benefit_open_reader());
    await h.advance(60_000);
    expect(h.reads).toHaveLength(15); // Explicit queued refresh is bounded even for an already paid order.
    await h.advance(60_000);
    expect(h.reads).toHaveLength(15);
    viewer = { ...viewer, subject: 'buyer-three' };
    await h.render();
    const final = deferred<ReconciliationResult>();
    h.reconciliations.push(final.promise);
    await h.click();
    await h.unmount();
    await act(async () => final.resolve({ kind: 'queued', orderId: secondId, reconciliation: 'queued' }));
    await h.advance(60_000);
    expect(h.reads).toHaveLength(15);
  } finally {
    await h.close();
  }
});

test('Canceled returns and native failure remain honest while native paid receipts retain current access', async () => {
  const h = await mount(receipt(), 'canceled');
  try {
    await h.advance(60_000);
    expect(h.reads).toHaveLength(0);
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_canceled());
    await h.render(receipt(secondId, 'failed'), 'success');
    expect(h.host.textContent).toContain(m.order_failed_detail());
    await h.advance(60_000);
    expect(h.reads).toHaveLength(0);
    await h.render(receipt(firstId, 'paid'), 'canceled');
    expect(h.host.querySelector('h1')!.textContent).toBe(m.order_paid());
    expect(h.host.textContent).toContain(m.benefit_open_reader());
  } finally {
    await h.close();
  }
});

test('Paid receipt retries unavailable current Access with a fresh read and no payment work', async () => {
  const initial = {
    ...receipt(firstId, 'paid'),
    entitlementId: '019a1b2c-3d4e-7f00-8a00-5b0000000081',
    entitlement: { kind: 'unavailable' as const },
    canUseBenefit: false,
  };
  const calls: { data: { id: string; locale: string } }[] = [];
  const response = deferred<OrderPageData>();
  accessRead = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('Temporary reader failure');
    return response.promise;
  };
  const h = await mount(initial);
  const recovery = () =>
    [...h.host.querySelectorAll('button')].find((button) => button.textContent === m.order_access_recovery_action());
  const status = (message: string) =>
    [...h.host.querySelectorAll('[role="status"]')].find((element) => element.textContent === message);
  try {
    expect(recovery()).toBeDefined();
    await act(async () => recovery()!.click());
    expect(status(m.order_access_recovery_failed())).toBeDefined();
    await act(async () => recovery()!.click());
    expect(status(m.order_access_recovery_pending())).toBeDefined();
    expect(recovery()!.disabled).toBe(true);
    expect(calls).toEqual([
      { data: { id: firstId, locale: 'en' } },
      { data: { id: firstId, locale: 'en' } },
    ]);
    response.resolve({ ...initial, entitlement: { kind: 'current', active: true }, canUseBenefit: true });
    await act(async () => {
      await response.promise;
    });
    expect(h.host.textContent).toContain(m.benefit_open_reader());
    expect(recovery()).toBeUndefined();
    expect(h.reads).toHaveLength(0);
    expect(h.intents).toHaveLength(0);
  } finally {
    accessRead = async () => {
      throw new Error('No current Access recovery read configured');
    };
    await h.close();
  }
});
