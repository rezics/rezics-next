import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, isNotFound, RouterProvider } from '@tanstack/react-router';
import type { OrderPageData, OrderMoney } from '../src/checkout/order';
import paid from '../src/kernel/recorded/order-paid.json';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';
import { receiptStoryMoney } from '../src/kernel/fake/checkout';
import { formatMinorAmount } from '../src/checkout/money';
import { m } from '../src/paraglide/messages.js';

let request: Request;
const headers = new Headers();
const buyer = '0192f3a0-6c1e-7b2a-9d4e-000000000081';
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid order:read entitlement:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({ status: 'active', subject: buyer, accessToken: 'buyer', csrfToken: null }),
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
const { loadOrderPage, orderStatusResponse } = await import('../src/checkout/order.server');
const { OrderPage, applyOrderStatus } = await import('../src/checkout/order-page');

async function receipt(order: OrderPageData, checkout?: 'success' | 'canceled') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = createRootRoute({
    component: () => createElement(OrderPage, { order, ...(checkout ? { checkout } : {}) }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/orders'] }) });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
    );
  } finally {
    queryClient.clear();
  }
}

// Contract-shaped HTTP inputs exercise the shipped generated client, session preparation, default BFF and renderer.
// Native persistence/provider acceptance remains a separate integration obligation; this test starts no services.
test('Buyer receipt shows recorded charge and truthful payment/access state', async () => {
  const calls: Request[] = [];
  let native = {
    ...paid.order,
    ...receiptStoryMoney,
    contentEdition: fixedEditionTerms,
    recordedPresentment: {
      currency: 'cad', moneyUnit: receiptStoryMoney.moneyUnit!, amountTotalMinor: 1647,
    } as OrderMoney['recordedPresentment'],
  };
  let current: unknown = {
    id: paid.order.entitlementId,
    offerId: paid.order.offerId,
    orderId: paid.order.id,
    targetSubjectId: paid.order.targetSubjectId,
    grantedAt: paid.order.createdAt,
    summary: paid.order.subject,
    active: true,
    revokedAt: null,
    revokeReason: null,
    contentEdition: fixedEditionTerms,
  };
  let entitlementStatus = 200;
  let orderStatus = 200;
  let offerPrice = 1200;
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path === `/v1/orders/${paid.order.id}`) return Response.json({ order: native }, { status: orderStatus });
    if (path === `/v1/entitlements/${paid.order.entitlementId}`)
      return Response.json({ entitlement: current }, { status: entitlementStatus });
    if (path === '/v1/viewerActions') return Response.json({ resources: [] });
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    if (path === `/v1/offers/${paid.order.offerId}`) return Response.json({ offer: { unitAmountMinor: offerPrice } });
    throw new Error(`Unexpected receipt request: ${call.method} ${path}`);
  });
  async function load() {
    request = new Request(`https://site.test/en/orders/${paid.order.id}?checkout=success`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    calls.length = 0;
    return loadOrderPage(paid.order.id, 'en');
  }
  try {
    const first = await load();
    const original = await receipt(first);
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(original).toContain('$12.00');
    expect(original).toContain('$12.96');
    expect(first.money?.recordedPresentment).toEqual(native.recordedPresentment);
    expect(original).toContain('CA$16.47 CAD');
    expect(original).toContain('$0.96');
    expect(original).toContain('USD');
    expect(original).toContain('txcd_10302000');
    expect(original).toContain(m.order_paid());
    expect(original).toContain(m.order_recorded_price_exclusive());
    expect(original).toContain(`/en/editions/${fixedEditionTerms.benefit.resource.id}`);
    expect(first.canUseBenefit).toBe(true);
    expect(calls.filter((call) => new URL(call.url).pathname.startsWith('/v1/orders/'))).toHaveLength(1);
    expect(calls.filter((call) => new URL(call.url).pathname.startsWith('/v1/entitlements/'))).toHaveLength(1);
    expect(
      calls
        .filter((call) => new URL(call.url).pathname !== '/v1/accounts')
        .every((call) => call.headers.get('authorization') === 'Bearer buyer'),
    ).toBe(true);

    offerPrice = 9900;
    const unchanged = await load();
    expect(unchanged.money).toEqual(first.money);
    expect(await receipt(unchanged)).toContain('$12.96');
    expect(calls.some((call) => new URL(call.url).pathname.startsWith('/v1/offers'))).toBe(false);

    current = { ...(current as object), active: false, revokedAt: '2026-11-01T00:00:00Z', revokeReason: 'refund' };
    const revoked = await load();
    const refunded = await receipt(revoked, 'canceled');
    expect(refunded).toContain(m.order_paid());
    expect(refunded).toContain(m.order_entitlement_revoked());
    expect(refunded).toContain('$12.96');
    expect(refunded).not.toContain(m.order_canceled());
    expect(refunded).not.toContain(m.benefit_open_reader());

    for (const settlement of ['failed', 'pending', 'unknown'] as const) {
      native = { ...native, settlement };
      for (const checkout of ['success', 'canceled'] as const) {
        const markup = await receipt(await load(), checkout);
        expect(markup).not.toContain(m.order_paid());
        expect(markup).not.toContain(m.order_receipt());
        expect(markup).not.toContain(m.benefit_fixed_version());
        expect(markup).not.toContain(m.entitlements_delivery_unknown());
        expect(markup).not.toContain(m.benefit_open_reader());
        expect(markup).not.toContain('$12.96');
        expect(markup).not.toContain('CA$16.47');
      }
    }
    native = { ...native, settlement: 'paid', recordedCharge: null, amountTaxMinor: null, recordedPresentment: null };
    const absent = await receipt(await load());
    expect(absent).toContain('$12.00');
    expect(absent).toContain(m.order_paid_total_unavailable());
    expect(absent).toContain(m.order_tax_unavailable());
    expect(absent).toContain(m.order_presentment_unavailable());
    expect(absent).not.toContain('$0.00');

    const unit = { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' } as const;
    native = {
      ...native,
      currency: 'jpy',
      unitAmountMinor: 1200,
      moneyUnit: unit,
      recordedCharge: { currency: 'jpy', moneyUnit: unit, amountTotalMinor: 1200, amountTaxMinor: 0 },
      recordedPresentment: { currency: 'jpy', moneyUnit: unit, amountTotalMinor: 1200 },
    };
    const scaleZero = await receipt(await load());
    expect(scaleZero).toContain(formatMinorAmount('en', 'jpy', 1200, unit)!);
    expect(scaleZero).toContain(formatMinorAmount('en', 'jpy', 0, unit)!);
    expect(scaleZero).toContain(`${formatMinorAmount('en', 'jpy', 1200, unit)} JPY`);

    for (const status of [403, 404, 503]) {
      entitlementStatus = status;
      const unavailable = await load();
      expect(unavailable.entitlement).toEqual({ kind: 'unavailable' });
      const markup = await receipt(unavailable);
      expect(markup).toContain(m.order_entitlement_unavailable());
      expect(markup).toContain(m.order_paid());
      expect(markup).not.toContain(m.benefit_open_reader());
    }
    const refreshed = applyOrderStatus({ ...first, settlement: 'pending' }, 'paid', first.offerId);
    expect(refreshed.entitlement).toEqual({ kind: 'refresh' });
    expect(await receipt(refreshed)).toContain(m.order_entitlement_refresh());
    expect(await receipt(refreshed)).not.toContain(m.benefit_open_reader());

    // The existing status route stays settlement-only and discloses no receipt or entitlement fields.
    calls.length = 0;
    expect(await (await orderStatusResponse(request, paid.order.id)).json()).toEqual({
      id: paid.order.id,
      offerId: paid.order.offerId,
      settlement: 'paid',
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([`/v1/orders/${paid.order.id}`]);
    orderStatus = 404;
    try {
      await load();
      throw new Error('Missing orders must be concealed');
    } catch (error) {
      expect(isNotFound(error)).toBe(true);
    }
    orderStatus = 403;
    await expect(load()).rejects.toThrow('Kernel order read failed');
  } finally {
    fetcher.mockRestore();
  }
});
