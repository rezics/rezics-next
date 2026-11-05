import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import type { AuthJourney } from './auth-stack.ts';
import {
  startNativePurchasesFixture,
  type NativePurchasesFixture,
  type NativePurchaseOrder,
} from './native-purchases-fixture.ts';

let fixture: NativePurchasesFixture;
let alice: AuthJourney;
let bob: AuthJourney;

setDefaultTimeout(180_000);

beforeAll(async () => {
  fixture = await startNativePurchasesFixture();
  alice = await fixture.auth.signIn('alice');
  bob = await fixture.auth.signIn('bob');
  expect((await alice.response()).status()).toBe(200);
  expect((await bob.response()).status()).toBe(200);
}, 300_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

async function orderFromApi(id: string, persona = 'alice') {
  const response = await fixture.stack.kernel(`/v1/orders/${id}`, {}, persona);
  expect(response.status).toBe(200);
  return ((await response.json()) as { order: Record<string, unknown> }).order;
}

async function ownedEntitlements() {
  const response = await fixture.stack.kernel('/v1/entitlements', {}, 'alice');
  expect(response.status).toBe(200);
  return ((await response.json()) as { entitlements: { orderId: string; id: string }[]; next: string | null })
    .entitlements;
}

async function createOrder(): Promise<NativePurchaseOrder> {
  return fixture.createOrder('alice');
}

async function waitForSettlement(id: string, settlement: 'paid' | 'failed') {
  const deadline = Date.now() + 30_000;
  let latest: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await fixture.stack.kernel(`/v1/orders/${id}`, {}, 'alice');
    expect(response.status).toBe(200);
    latest = ((await response.json()) as { order: Record<string, unknown> }).order;
    if (latest.settlement === settlement) return latest;
    await Bun.sleep(50);
  }
  throw new Error(`Native order ${id} did not settle as ${settlement}: ${JSON.stringify(latest)}`);
}

async function openOffer(page: Page) {
  await page.goto(`${fixture.stack.web}/en/offers/${fixture.offer.id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await page.getByRole('heading', { name: fixture.offer.subjectTitle }).count()).toBe(1);
  expect(await page.getByText(fixture.offer.title, { exact: true }).count()).toBeGreaterThan(0);
}

function localReturnUrl(order: NativePurchaseOrder): string {
  const providerSession = fixture.stripe.sessions.get(order.sessionId);
  if (!providerSession?.success_url) throw new Error(`Stripe did not capture a success URL for ${order.id}`);
  const returned = new URL(providerSession.success_url);
  return new URL(`${returned.pathname}${returned.search}`, fixture.stack.web).href;
}

test('Alice starts native Checkout from an existing offer; the return stays pending until verified delivery, then pays once', async () => {
  const page = await alice.context.newPage();
  page.setDefaultTimeout(20_000);
  await page.route('https://checkout.stripe.com/**', (route) => route.abort());
  await openOffer(page);

  const nativeRequestsBefore = fixture.stack.kernelRequests().length;
  const createResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === new URL(fixture.stack.web).origin &&
      new URL(response.url()).pathname === '/checkout' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /buy/i }).click();
  const created = await createResponse;
  expect(created.status()).toBe(200);
  const createdBody = (await created.json()) as { checkoutUrl: string };
  expect(createdBody.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  const sessionId = new URL(createdBody.checkoutUrl).pathname.split('/').at(-1)!;
  const providerSession = fixture.stripe.sessions.get(sessionId);
  if (!providerSession?.client_reference_id) throw new Error(`Checkout Session ${sessionId} has no order reference`);
  const orderId = providerSession.client_reference_id;
  const started = await fixture.orderFor(orderId);
  expect(started).toMatchObject({ id: orderId, offerId: fixture.offer.id, settlement: 'pending', sessionId });
  expect(fixture.stack.kernelRequests().slice(nativeRequestsBefore)).toContainEqual(
    expect.objectContaining({ method: 'POST', url: '/v1/orders', authorization: expect.stringMatching(/^Bearer /) }),
  );

  const returnUrl = localReturnUrl(started);
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await page.getByRole('heading', { name: /pending|processing|awaiting/i }).count()).toBe(1);
  expect(await page.getByRole('heading', { name: /receipt/i }).count()).toBe(0);
  expect((await orderFromApi(orderId)).settlement).toBe('pending');
  expect(await ownedEntitlements()).toEqual([]);

  await page.goto(`${returnUrl}&payment_status=paid&success=true`, { waitUntil: 'domcontentloaded' });
  expect((await orderFromApi(orderId)).settlement).toBe('pending');
  expect(await ownedEntitlements()).toEqual([]);
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect((await orderFromApi(orderId)).settlement).toBe('pending');
  expect(await ownedEntitlements()).toEqual([]);

  await fixture.stripe.pay(started.sessionId);
  const paidEvent = await fixture.stripe.event('checkout.session.completed', started.sessionId);
  expect((await fixture.deliver(paidEvent)).status).toBe(200);
  const paid = await waitForSettlement(orderId, 'paid');
  expect(paid.entitlementId).toEqual(expect.any(String));
  const entitlementResponse = await fixture.stack.kernel(`/v1/entitlements/${paid.entitlementId}`, {}, 'alice');
  expect(entitlementResponse.status).toBe(200);
  expect(((await entitlementResponse.json()) as { entitlement: Record<string, unknown> }).entitlement).toMatchObject({
    orderId,
    offerId: fixture.offer.id,
    targetSubjectId: fixture.offer.subjectId,
    active: true,
    revokedAt: null,
  });

  expect((await fixture.deliver(paidEvent)).status).toBe(200);
  await waitForSettlement(orderId, 'paid');
  const matching = (await ownedEntitlements()).filter((item) => item.orderId === orderId);
  expect(matching).toHaveLength(1);
  fixture.paidOrderId = orderId;
  fixture.paidEntitlementId = paid.entitlementId as string;
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.getByRole('heading', { name: /paid|receipt/i }).count()).toBeGreaterThan(0);
  expect(await page.getByRole('heading', { name: /receipt/i }).count()).toBe(1);
  const paidOrder = await orderFromApi(orderId);
  expect(paidOrder.settlement).toBe('paid');
  console.info(`REAL_NATIVE_ORDER_DETAIL_RECORDING ${JSON.stringify({ status: 200, order: paidOrder })}`);
  await page.close();
});

test('a verified failed delivery remains failed; forged return parameters never create a receipt or entitlement', async () => {
  const order = await createOrder();
  await fixture.stripe.pay(order.sessionId, 'async');
  fixture.stripe.failPayment(order.sessionId);
  const failedEvent = await fixture.stripe.event('checkout.session.async_payment_failed', order.sessionId);
  expect((await fixture.deliver(failedEvent)).status).toBe(200);
  const failed = await waitForSettlement(order.id, 'failed');
  expect(failed.entitlementId).toBeNull();
  fixture.failedOrderId = order.id;
  expect((await ownedEntitlements()).some((item) => item.orderId === order.id)).toBe(false);

  const page = await alice.context.newPage();
  const returnUrl = `${localReturnUrl(order)}&payment_status=paid&success=true`;
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await page.getByRole('heading', { name: /failed|declined|unsuccessful/i }).count()).toBe(1);
  expect(await page.getByRole('heading', { name: /receipt/i }).count()).toBe(0);
  expect((await orderFromApi(order.id)).settlement).toBe('failed');
  expect((await ownedEntitlements()).some((item) => item.orderId === order.id)).toBe(false);
  await page.close();
});

test('the buyer pages captured order history; Bob and anonymous cannot enumerate, reuse its cursor, or read its receipt', async () => {
  const bobEmptyPage = await fixture.listOrders('bob');
  expect(bobEmptyPage.orders).toEqual([]);
  console.info(
    `REAL_NATIVE_ORDERS_EMPTY_RECORDING ${JSON.stringify({ status: 200, orders: bobEmptyPage.orders, next: bobEmptyPage.next })}`,
  );
  const bobEmptyBrowser = await bob.context.newPage();
  await bobEmptyBrowser.goto(`${fixture.stack.web}/en/orders`, { waitUntil: 'domcontentloaded' });
  await bobEmptyBrowser.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await bobEmptyBrowser.getByRole('heading', { name: /your orders/i }).count()).toBe(1);
  expect(await bobEmptyBrowser.getByText(/haven't bought anything yet/i).count()).toBe(1);
  expect(await bobEmptyBrowser.locator('[data-order-row]').count()).toBe(0);
  await bobEmptyBrowser.close();

  const page = await alice.context.newPage();
  const measuredGrowth: number[] = [];
  let unrelatedOrders = 0;
  for (const target of [1, 8, 64]) {
    while (unrelatedOrders < target) {
      await fixture.createOrder('bob');
      unrelatedOrders++;
    }
    const beforeGrowthPage = fixture.stack.kernelRequests().length;
    await page.goto(`${fixture.stack.web}/en/orders`, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(await page.locator('[data-order-row]').count()).toBe(2);
    expect(await page.getByRole('link', { name: 'Orders', exact: true }).count()).toBe(1);
    const growthRequests = fixture.stack.kernelRequests().slice(beforeGrowthPage);
    measuredGrowth.push(
      growthRequests.filter((request) => request.method === 'GET' && /^\/v1\/orders(?:\?|$)/.test(request.url)).length,
    );
    expect(
      growthRequests.filter((request) => request.method === 'GET' && /^\/v1\/orders\//.test(request.url)),
    ).toHaveLength(0);
  }
  expect(measuredGrowth).toEqual([1, 1, 1]);

  const pending: NativePurchaseOrder[] = [];
  for (let index = 0; index < 19; index++) pending.push(await createOrder());
  const delisted = await fixture.delistOffer();
  expect(delisted.state).toBe('delisted');

  const apiPage = await fixture.listOrders('alice');
  expect(apiPage.orders.length).toBeGreaterThan(0);
  expect(apiPage.orders.length).toBeLessThanOrEqual(20);
  expect(apiPage.next).not.toBeNull();
  expect(apiPage.responseKeys).not.toContain('count');
  expect(apiPage.responseKeys).not.toContain('total');
  expect(apiPage.responseKeys).not.toContain('offset');
  expect(apiPage.orders.every((row) => row.offerId === fixture.offer.id && row.title === fixture.offer.title)).toBe(
    true,
  );
  expect(apiPage.orders.every((row) => row.currency === 'usd' && row.unitAmountMinor === 1200)).toBe(true);

  const seen: string[] = [];
  let url = `${fixture.stack.web}/en/orders`;
  let pages = 0;
  let paidRowSeen = false;
  let failedRowSeen = false;
  let paidPageUrl: string | undefined;
  const perRowRequestsBefore = fixture.stack.kernelRequests().length;
  while (url) {
    const currentPageUrl = url;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    pages++;
    expect(pages).toBeLessThanOrEqual(2);
    const rows = page.locator('[data-order-row]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
    for (let index = 0; index < count; index++) {
      const row = rows.nth(index);
      const link = row.getByRole('link');
      const href = await link.getAttribute('href');
      expect(href).toMatch(/^\/en\/orders\/[0-9a-f-]+$/i);
      const id = href!.split('/').at(-1)!;
      expect(seen).not.toContain(id);
      seen.push(id);
      expect(await row.innerText()).toContain(fixture.offer.title);
      expect(await row.innerText()).toMatch(/\$12\.00/);
      expect(await row.getAttribute('data-settlement')).toMatch(/^(pending|paid|failed|unknown)$/);
      if (id === fixture.paidOrderId) {
        paidRowSeen = true;
        paidPageUrl = currentPageUrl;
        expect(await row.getAttribute('data-settlement')).toBe('paid');
        expect(await row.getAttribute('data-entitlement')).toBeTruthy();
      }
      if (id === fixture.failedOrderId) {
        failedRowSeen = true;
        expect(await row.getAttribute('data-settlement')).toBe('failed');
        expect(await row.getAttribute('data-entitlement')).toBe('');
      }
    }
    const next = page.getByRole('link', { name: /next/i });
    if ((await next.count()) === 0) break;
    url = new URL((await next.getAttribute('href'))!, fixture.stack.web).href;
    expect(new URL(url).searchParams.has('cursor')).toBe(true);
    expect(new URL(url).searchParams.has('offset')).toBe(false);
  }
  expect(pages).toBe(2);
  expect(paidRowSeen).toBe(true);
  expect(failedRowSeen).toBe(true);
  expect(paidPageUrl).toBeDefined();
  const secondApiPage = await fixture.listOrders('alice', apiPage.next!);
  expect(secondApiPage.next).toBeNull();
  console.info(
    `REAL_NATIVE_ORDERS_PAGE_RECORDING ${JSON.stringify({ status: 200, orders: secondApiPage.orders, next: secondApiPage.next })}`,
  );
  const storyOrder = secondApiPage.orders[0];
  if (!storyOrder) throw new Error('The final native order history page is empty');
  console.info(
    `REAL_NATIVE_ORDER_HISTORY_DETAIL_RECORDING ${JSON.stringify({ status: 200, order: await orderFromApi(storyOrder.id) })}`,
  );
  expect(seen).toEqual(apiPage.orders.map((row) => row.id).concat(secondApiPage.orders.map((row) => row.id)));
  const requests = fixture.stack.kernelRequests().slice(perRowRequestsBefore);
  expect(
    requests.filter((request) => request.method === 'GET' && /^\/v1\/orders(?:\?|$)/.test(request.url)),
  ).toHaveLength(2);
  expect(requests.filter((request) => request.method === 'GET' && /^\/v1\/orders\//.test(request.url))).toHaveLength(0);

  await page.goto(paidPageUrl!, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-order-row][data-order-id="${fixture.paidOrderId}"]`).getByRole('link').click();
  await page.waitForURL((current) => current.pathname === `/en/orders/${fixture.paidOrderId}`);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(new URL(page.url()).pathname).toBe(`/en/orders/${fixture.paidOrderId}`);
  expect(await page.getByRole('heading', { name: /receipt/i }).count()).toBe(1);

  const cursor = apiPage.next!;
  const bobList = await fixture.stack.kernel('/v1/orders', {}, 'bob');
  expect(bobList.status).toBe(200);
  const bobOrders = ((await bobList.json()) as { orders: { id: string }[] }).orders;
  expect(bobOrders).toHaveLength(20);
  expect(bobOrders.every((order) => !seen.includes(order.id))).toBe(true);
  const bobCursor = await fixture.stack.kernel(`/v1/orders?cursor=${encodeURIComponent(cursor)}`, {}, 'bob');
  expect(bobCursor.status).not.toBe(200);
  const anonymous = await fixture.stack.kernel('/v1/orders');
  expect(anonymous.status).toBe(401);
  const anonymousCursor = await fixture.stack.kernel(`/v1/orders?cursor=${encodeURIComponent(cursor)}`);
  expect(anonymousCursor.status).toBe(401);
  const anonymousKnownOrder = await fixture.stack.kernel(`/v1/orders/${fixture.paidOrderId}`);
  expect(anonymousKnownOrder.status).toBe(404);
  const anonymousKnownEntitlement = await fixture.stack.kernel(`/v1/entitlements/${fixture.paidEntitlementId}`);
  expect(anonymousKnownEntitlement.status).toBe(404);

  const knownOrder = await fixture.stack.kernel(`/v1/orders/${fixture.paidOrderId}`, {}, 'bob');
  expect(knownOrder.status).toBe(404);
  const bobPage = await bob.context.newPage();
  await bobPage.goto(`${fixture.stack.web}/en/orders/${fixture.paidOrderId}`, { waitUntil: 'domcontentloaded' });
  await bobPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(await bobPage.getByRole('heading', { name: /receipt/i }).count()).toBe(0);
  expect(await bobPage.getByText(fixture.offer.title, { exact: true }).count()).toBe(0);
  const knownEntitlement = await fixture.stack.kernel(`/v1/entitlements/${fixture.paidEntitlementId}`, {}, 'bob');
  expect(knownEntitlement.status).toBe(404);
  const anonymousContext = await fixture.auth.context('anonymous');
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(`${fixture.stack.web}/en/orders/${fixture.paidOrderId}`, { waitUntil: 'domcontentloaded' });
  expect(new URL(anonymousPage.url()).pathname).toMatch(/^\/auth\/sign-in$/);
  expect(await anonymousPage.getByText(fixture.offer.title, { exact: true }).count()).toBe(0);
  await page.close();
  await bobPage.close();
  await anonymousPage.close();
  expect(pending.length).toBe(19);
});
