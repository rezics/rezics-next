import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { formatOfferPrice } from '../src/checkout/price.ts';
import type { OfferPageData } from '../src/checkout/offer.ts';
import type { OrderPageData } from '../src/checkout/order.ts';
import type { BuyerOrderPage } from '../src/checkout/orders.ts';
import { subjectCover } from '../src/checkout/subject-cover.tsx';

const { OfferPage } = await import('../src/checkout/offer-page.tsx');
const { OrderPage, applyOrderStatus } = await import('../src/checkout/order-page.tsx');
const { OrdersPage } = await import('../src/checkout/orders-page.tsx');

const subjectId = '01a17a79-d88a-77aa-a166-81d2b657df87';
const offerId = '01a17a7a-477c-777f-9812-c7322f4814a8';
const orderId = '01a17a7a-4833-72f9-95e4-074c6aca9bb5';
const title = 'The Little Prince';
const subject = subjectCover('en', subjectId, 'Book edition', {
  id: subjectId,
  types: ['schema:Book'],
  label: { value: title, language: 'en' },
  cover: null,
});
const offer: OfferPageData = {
  id: offerId,
  title: 'Book edition',
  currency: 'usd',
  unitAmountMinor: 1299,
  state: 'active',
  price: formatOfferPrice('en', 'usd', 1299),
  idempotencyKey: 'checkout-key',
  subject,
};
const paidOrder: OrderPageData = {
  id: orderId,
  offerId,
  title: 'Book edition',
  settlement: 'paid',
  entitlementId: null,
  entitlement: { kind: 'none' },
  createdAt: '2026-10-26T23:09:56.659Z',
  subject,
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

test('an offer shows its subject cover and localized subject title, price, included item, and one buy action', () => {
  const html = renderToString(createElement(OfferPage, { offer }));
  expect(html).toContain('data-slot="cover"');
  expect(text(html)).toContain(title);
  expect(text(html)).toContain(formatOfferPrice('en', 'usd', 1299));
  expect(text(html)).toContain('You receive');
  expect(text(html)).toContain(offer.title);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<button\b/g)).toHaveLength(1);
});

test('the displayed title and subject link use the label selected for the page locale', () => {
  const localizedSubject = subjectCover('zh-Hans', subjectId, offer.title, {
    id: subjectId,
    types: ['schema:Book'],
    label: { value: '小王子', language: 'zh-Hans' },
    cover: null,
  });
  const html = renderToString(createElement(OfferPage, { offer: { ...offer, subject: localizedSubject } }));
  expect(html).toContain('<h1');
  expect(text(html)).toContain('小王子');
  expect(html).toContain('/zh-Hans/subjects/');
  expect(html).not.toMatch(/<h1[^>]*>[^<]*註解/);
});

test('a paid order shows a linked receipt and next steps without an ISO timestamp', () => {
  const html = renderToString(createElement(OrderPage, { order: paidOrder, checkout: 'success' }));
  expect(html).toContain('data-slot="cover"');
  expect(html).toContain(`/en/subjects/${subjectId}/the-little-prince`);
  expect(html).toContain(`/en/offers/${offerId}`);
  expect(html).toContain('/en/library');
  expect(html).toContain('>Receipt</h2>');
  expect(html).toContain('>Order placed</dt>');
  expect(text(html)).toContain(
    new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(paidOrder.createdAt)),
  );
  expect(text(html)).toContain(orderId);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
});

test('pending, failed, and canceled orders communicate their state and the failure states link to the offer', () => {
  const pending = renderToString(createElement(OrderPage, { order: { ...paidOrder, settlement: 'pending' } }));
  expect(text(pending)).toMatch(/confirm|payment|processing/i);
  for (const checkout of [undefined, 'canceled'] as const) {
    const html = renderToString(
      createElement(OrderPage, {
        order: { ...paidOrder, settlement: checkout ? 'pending' : 'failed' },
        ...(checkout ? { checkout } : {}),
      }),
    );
    expect(html).toContain(`/en/offers/${offerId}`);
    expect(text(html)).toMatch(/payment|cancel/i);
  }
});

test('buyer order history shows captured terms and current order state with bounded cursor navigation', () => {
  const entitlementId = '01a17a7a-5e10-78d7-b57a-c2a70f31c9aa';
  const history: BuyerOrderPage = {
    orders: [
      {
        id: orderId,
        offerId,
        title: 'Book edition',
        targetSubjectId: subjectId,
        offerRevision: 3,
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: 'txcd_10302000',
        amountTaxMinor: null,
        settlement: 'paid',
        entitlementId,
        createdAt: paidOrder.createdAt,
        checkoutUrl: null,
        checkoutExpiresAt: null,
      },
    ],
    next: 'signed-cursor',
  };
  const html = renderToString(createElement(OrdersPage, { page: history, locale: 'en' }));

  expect(html).toContain(`/en/orders/${orderId}`);
  expect(html).toContain('?cursor=signed-cursor');
  expect(html).toContain(`data-order-id="${orderId}"`);
  expect(html).toContain(`data-entitlement="${entitlementId}"`);
  expect(text(html)).toContain('Book edition');
  expect(text(html)).toContain(new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(12.99));
  expect(text(html)).toContain('Paid');
  expect(text(html)).toContain('Entitlement recorded');
});

test('page headings share the shell heading size and long CJK offer titles fit a narrow layout', () => {
  const long = '小王子（全新註解・雙語對照・電子書典藏版）——附作者手繪水彩插圖、譯者導讀與版本考證';
  const html = renderToString(createElement(OfferPage, { offer: { ...offer, title: long } }));
  expect(html).toContain('text-4xl');
  expect(html).toContain('text-balance');
  expect(html).toContain('min-w-0');
  expect(html).toContain('break-words');
});

test('selected order current access uses one associated point read and keeps failures distinct from null', async () => {
  const entitlementId = '01a17a7a-5e10-78d7-b57a-c2a70f31c9aa';
  const otherId = '01a17a7a-4856-7052-a40c-074c3803e6ce';
  const credential = 'Bearer prepared-buyer';
  let request: Request;
  let credentials = 0;
  const headers = new Headers();
  const calls: Request[] = [];
  const env = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          credentials += 1;
          return { status: 'active', subject: 'buyer', accessToken: 'prepared-buyer', csrfToken: 'csrf' };
        },
      }),
    },
  };
  mock.module('cloudflare:workers', () => ({ env }));
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: () => request,
    setResponseHeader: (name: string, value: string) => headers.set(name, value),
  }));
  const fetcher = spyOn(globalThis, 'fetch');
  const { loadOrderPage, orderStatusResponse } = await import('../src/checkout/order.server.ts');
  const current = {
    id: entitlementId,
    offerId,
    orderId,
    targetSubjectId: subjectId,
    summary: { title },
    grantedAt: paidOrder.createdAt,
    revokedAt: null,
    revokeReason: null,
    active: true,
  };
  async function load(nativeId: string | null, response: Response | Error, settlement: OrderPageData['settlement'] = 'paid') {
    request = new Request(`https://site.test/en/orders/${orderId}?entitlementId=${otherId}&checkout=success`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    calls.length = 0;
    credentials = 0;
    headers.delete('cache-control');
    fetcher.mockImplementation(async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      if (new URL(call.url).pathname === `/v1/orders/${orderId}`)
        return Response.json({
          order: { ...paidOrder, settlement, entitlementId: nativeId, targetSubjectId: subjectId, subject: null },
        });
      if (response instanceof Error) throw response;
      return response.clone();
    });
    const [order, repeated] = await Promise.all([loadOrderPage(orderId, 'en'), loadOrderPage(orderId, 'en')]);
    expect(repeated).toEqual(order);
    expect(credentials).toBe(1);
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      `/v1/orders/${orderId}?languages=en`,
      ...(nativeId === null ? [] : [`/v1/entitlements/${entitlementId}`]),
    ]);
    expect(calls.every((call) => call.method === 'GET' && call.headers.get('authorization') === credential)).toBe(true);
    expect(order.entitlementId).toBe(nativeId);
    expect(order.settlement).toBe(settlement);
    expect(order.title).toBe(paidOrder.title);
    return order;
  }
  const render = (order: OrderPageData) => text(renderToString(createElement(OrderPage, { order })));
  try {
    const active = await load(entitlementId, Response.json({ entitlement: current }));
    expect(active.entitlement).toEqual({ kind: 'current', active: true });
    expect(render(active)).toContain('Current access Active');

    const refunded = await load(entitlementId, Response.json({ entitlement: {
      ...current, active: false, revokedAt: '2026-10-30T00:00:00Z', revokeReason: 'refund',
    } }));
    expect(refunded.entitlement).toEqual({ kind: 'current', active: false });
    expect(render(refunded)).toContain('Current access Revoked');
    expect(render(refunded)).toContain('Payment received');
    expect(render(refunded)).toContain('Receipt');

    const absent = await load(null, new Error('null must never read an entitlement'));
    expect(absent.entitlement).toEqual({ kind: 'none' });
    expect(render(absent)).toContain('No entitlement');

    // Denied/hidden, missing, unavailable, malformed and unrelated records share no access claim.
    for (const response of [
      Response.json({}, { status: 403 }),
      Response.json({}, { status: 404 }),
      Response.json({}, { status: 503 }),
      new Error('upstream disconnected'),
      Response.json({ entitlement: { ...current, active: 'true' } }),
      Response.json({ entitlement: { ...current, id: otherId } }),
      Response.json({ entitlement: { ...current, orderId: otherId } }),
    ]) {
      const unavailable = await load(entitlementId, response);
      expect(unavailable.entitlement).toEqual({ kind: 'unavailable' });
      expect(render(unavailable)).toContain('Current access could not be checked.');
      expect(render(unavailable)).not.toContain('No entitlement');
      expect(render(unavailable)).toContain('Payment received');
      expect(render(unavailable)).not.toContain(otherId);
    }

    // Status reads stay settlement-only even when the selected order has an entitlement.
    await load(entitlementId, Response.json({ entitlement: current }));
    calls.length = 0;
    const status = await orderStatusResponse(request, orderId);
    expect(await status.json()).toEqual({ id: orderId, offerId, settlement: 'paid' });
    expect(status.headers.get('cache-control')).toBe('private, no-store');
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([`/v1/orders/${orderId}`]);
    expect(credentials).toBe(1);
  } finally {
    fetcher.mockRestore();
  }
});

test('a pending order becoming paid requires a current access refresh instead of reusing initial access', () => {
  for (const entitlement of [{ kind: 'none' }, { kind: 'current', active: true }] as const) {
    const pending: OrderPageData = { ...paidOrder, settlement: 'pending', entitlement };
    const paid = applyOrderStatus(pending, 'paid', offerId);
    expect(paid.entitlement).toEqual({ kind: 'refresh' });
    const html = renderToString(createElement(OrderPage, { order: paid }));
    expect(text(html)).toContain('Payment received');
    expect(text(html)).toContain('Refresh to check current access.');
    expect(text(html)).not.toContain('Current access Active');
    expect(text(html)).not.toContain('No entitlement');
    expect(html).toContain('>Refresh</button>');
  }
});
