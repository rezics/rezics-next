import { expect, mock, spyOn, test } from 'bun:test';
import { isNotFound } from '@tanstack/react-router';
import type { SessionEnv } from '../src/session/client';
import { prepareSession, viewerCredential } from '../src/session/request';
import paid from '../src/kernel/recorded/order-paid.json';
import { fixedEditionTerms, mappedEntitlement } from '../src/kernel/fake/entitlements';
import { acquisitionProblems, receiptStoryMoney } from '../src/kernel/fake/checkout';

const origin = 'https://site.test';
const buyer = '0192f3a0-6c1e-7b2a-9d4e-000000000081';
const other = '0192f3a0-6c1e-7b2a-9d4e-000000000082';
const csrfToken = 'A'.repeat(22);
const intent = { offerId: paid.order.offerId, expectedOfferRevision: 7, idempotencyKey: other };
const session = {
  status: 'active' as 'active' | 'absent' | 'unavailable',
  token: 'buyer',
  subject: buyer,
  calls: 0,
  failure: undefined as Error | undefined,
};
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  SITE_ORIGINS: origin,
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid order:read entitlement:read order:create',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        session.calls++;
        if (session.failure) throw session.failure;
        return session.status === 'active'
          ? { status: 'active', accessToken: session.token, subject: session.subject, csrfToken }
          : { status: session.status, csrfToken };
      },
      signedIn: async () => ({ signedIn: session.status === 'active', csrfToken }),
    }),
  } as unknown as SessionEnv['SESSIONS'],
};
let request: Request;
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { loadOrder, loadOrderPage, orderStatusResponse } = await import('../src/checkout/order.server');
const { startCheckout } = await import('../src/checkout/start');

function pageRequest() {
  return new Request(`${origin}/en/orders/${paid.order.id}`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
}
function checkoutRequest(body = JSON.stringify(intent), explicit = false) {
  return new Request(`${origin}/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(explicit
        ? { authorization: 'Bearer explicit' }
        : { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin, 'x-csrf-token': csrfToken }),
    },
    body,
  });
}
async function concealed(read: Promise<unknown>) {
  try {
    await read;
    throw new Error('Receipt must be concealed');
  } catch (error) {
    expect(isNotFound(error)).toBe(true);
  }
}
function nativeHarness() {
  Object.assign(session, { status: 'active', token: 'buyer', subject: buyer, calls: 0, failure: undefined });
  const calls: Request[] = [];
  const native = {
    order: { ...paid.order, ...receiptStoryMoney, contentEdition: fixedEditionTerms },
    entitlement: { ...mappedEntitlement },
    orderStatus: 200,
    entitlementStatus: 200,
    reconcile: true,
    checkoutStatus: 200,
    checkout: { order: paid.order } as unknown,
  };
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call.clone());
    const path = new URL(call.url).pathname;
    if (path === '/v1/orders' && call.method === 'POST')
      return Response.json(native.checkout, { status: native.checkoutStatus });
    if (path === `/v1/orders/${paid.order.id}`)
      return Response.json({ order: native.order }, { status: native.orderStatus });
    if (path === `/v1/entitlements/${paid.order.entitlementId}`)
      return Response.json({ entitlement: native.entitlement }, { status: native.entitlementStatus });
    if (path === '/v1/viewerActions')
      return Response.json({
        resources: [
          {
            type: 'access.account',
            id: session.subject,
            viewerActions: [{ action: 'order:reconcile', operations: native.reconcile ? ['order.reconcile'] : [] }],
          },
        ],
      });
    if (path === '/v1/accounts')
      return Response.json({ accounts: [{ id: fixedEditionTerms.creatorAccountId, displayName: 'Captured creator' }] });
    throw new Error(`Unexpected native request: ${call.method} ${path}`);
  });
  const privateCalls = () =>
    calls.filter((call) => /\/v1\/(orders|entitlements)(\/|$)/.test(new URL(call.url).pathname));
  return { calls, native, privateCalls, restore: () => fetcher.mockRestore() };
}
function restrictive(calls: Request[]) {
  for (const call of calls) expect([call.cache, call.redirect]).toEqual(['no-store', 'manual']);
}

// UNRUN: actual session preparation and generated HTTP client; no native/provider/integration proof.
test('cached receipts and status renew admission before disclosure, retaining bounded healthy reads', async () => {
  const h = nativeHarness();
  try {
    request = pageRequest();
    await loadOrder(paid.order.id, 'en');
    const first = await loadOrderPage(paid.order.id, 'en');
    expect(first).toMatchObject({
      money: receiptStoryMoney,
      benefit: { kind: 'mapped', terms: fixedEditionTerms },
      entitlement: { kind: 'current', active: true },
      canUseBenefit: true,
      creatorName: 'Captured creator',
      canReconcile: true,
    });
    h.native.reconcile = false;
    expect((await loadOrderPage(paid.order.id, 'en')).canReconcile).toBe(false);
    for (let repeat = 0; repeat < 2; repeat++) {
      const beforeStatus = h.calls.length;
      const status = await orderStatusResponse(request, paid.order.id);
      expect(await status.json()).toEqual({ id: paid.order.id, offerId: paid.order.offerId, settlement: 'paid' });
      expect(status.headers.get('cache-control')).toBe('private, no-store');
      expect(h.calls).toHaveLength(beforeStatus + (repeat === 0 ? 1 : 0));
    }
    expect(session.calls).toBe(5);
    expect(h.privateCalls().map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      `/v1/orders/${paid.order.id}?languages=en`,
      `/v1/entitlements/${paid.order.entitlementId}`,
      `/v1/orders/${paid.order.id}`,
    ]);
    restrictive(h.privateCalls());
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(h.privateCalls().every((call) => call.headers.get('authorization') === 'Bearer buyer')).toBe(true);
    const before = h.calls.length;
    session.status = 'absent';
    await concealed(loadOrder(paid.order.id, 'en'));
    await concealed(loadOrderPage(paid.order.id, 'en'));
    const refused = await orderStatusResponse(request, paid.order.id);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe('');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(viewerCredential(request)).toBe('Bearer buyer');
    session.status = 'unavailable';
    for (const read of [
      () => loadOrder(paid.order.id, 'en'),
      () => loadOrderPage(paid.order.id, 'en'),
      () => orderStatusResponse(request, paid.order.id),
    ])
      await expect(read()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    const preparations = session.calls;
    expect((await orderStatusResponse(request, 'invalid')).status).toBe(404);
    expect(session.calls).toBe(preparations);
    expect(h.calls).toHaveLength(before);

    // Even the same credential must read anew after a refusal, then after either identity component changes.
    session.status = 'active';
    for (const identity of [
      { token: 'buyer', subject: buyer },
      { token: 'changed', subject: buyer },
      { token: 'changed', subject: other },
    ]) {
      Object.assign(session, identity);
      h.native.order.title = `Receipt for ${identity.token}/${identity.subject}`;
      h.native.entitlement.active = false;
      const count = h.privateCalls().length;
      const next = await loadOrderPage(paid.order.id, 'en');
      expect(next.title).toBe(h.native.order.title);
      expect(next.canUseBenefit).toBe(false);
      expect(h.privateCalls()).toHaveLength(count + 2);
    }
    session.status = 'absent';
    request.headers.set('authorization', 'Bearer explicit');
    const preparationsBeforeExplicit = session.calls;
    const count = h.privateCalls().length;
    expect((await loadOrderPage(paid.order.id, 'en')).canReconcile).toBe(false);
    expect(h.privateCalls()).toHaveLength(count + 2);
    expect(session.calls).toBe(preparationsBeforeExplicit);
    expect(
      h
        .privateCalls()
        .slice(-2)
        .every((call) => call.headers.get('authorization') === 'Bearer explicit'),
    ).toBe(true);
    restrictive(h.privateCalls());
  } finally {
    h.restore();
  }
});

test('receipt admission preserves native concealment, captured benefit association and preparation failures', async () => {
  const h = nativeHarness();
  try {
    for (const patch of [
      { id: other },
      { orderId: other },
      { active: false },
      { revokedAt: '2026-11-01T00:00:00Z', revokeReason: 'refund' },
      { contentEdition: { ...fixedEditionTerms, saleTermsReference: 'different captured terms' } },
    ]) {
      request = pageRequest();
      h.native.entitlement = { ...mappedEntitlement, ...patch };
      const order = await loadOrderPage(paid.order.id, 'en');
      expect(order.canUseBenefit).toBe(false);
      expect(order.money).toEqual(receiptStoryMoney);
      expect(order.settlement).toBe('paid');
    }
    h.native.entitlementStatus = 404;
    request = pageRequest();
    expect((await loadOrderPage(paid.order.id, 'en')).entitlement).toEqual({ kind: 'unavailable' });
    for (const status of [404, 403, 503]) {
      h.native.orderStatus = status;
      request = pageRequest();
      if (status === 404) {
        await concealed(loadOrderPage(paid.order.id, 'en'));
        expect((await orderStatusResponse(request, paid.order.id)).status).toBe(404);
      } else {
        await expect(loadOrderPage(paid.order.id, 'en')).rejects.toThrow('Kernel order read failed');
        await expect(orderStatusResponse(request, paid.order.id)).rejects.toThrow('Kernel order read failed');
      }
    }
    session.failure = new Error('session transport failed');
    const before = h.calls.length;
    await expect(loadOrderPage(paid.order.id, 'en')).rejects.toBe(session.failure);
    await expect(orderStatusResponse(request, paid.order.id)).rejects.toBe(session.failure);
    expect(h.calls).toHaveLength(before);
  } finally {
    h.restore();
  }
});

test('Checkout refuses stale preparation before parsing and preserves real unsafe session and explicit-auth semantics', async () => {
  const h = nativeHarness();
  try {
    // A safe helper invocation reaches prepareSession's true result; unsafe absent cookies actually throw 403.
    const safe = pageRequest();
    expect(await prepareSession(safe, env)).toBe(false);
    const unsafe = checkoutRequest('{invalid JSON');
    expect(await prepareSession(unsafe, env)).toBe(false);
    session.status = 'absent';
    const refused = await startCheckout(safe, env);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      type: 'https://rezics.com/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      code: 'unauthorized',
    });
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    await expect(startCheckout(unsafe, env)).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    expect(unsafe.bodyUsed).toBe(false);
    session.status = 'unavailable';
    await expect(startCheckout(unsafe, env)).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    session.status = 'active';
    for (const header of ['origin', 'x-csrf-token']) {
      const invalid = checkoutRequest();
      invalid.headers.set(header, 'invalid');
      await expect(startCheckout(invalid, env)).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
      expect(invalid.bodyUsed).toBe(false);
    }
    const explicitCookie = checkoutRequest();
    explicitCookie.headers.set('authorization', 'Bearer explicit');
    session.status = 'absent';
    await expect(startCheckout(explicitCookie, env)).rejects.toMatchObject({
      problem: { status: 403, code: 'forbidden' },
    });
    expect(h.calls).toHaveLength(0);
    session.status = 'active';
    for (const input of [checkoutRequest(), checkoutRequest(undefined, true), explicitCookie]) {
      const response = await startCheckout(input, env);
      expect(await response.json()).toEqual({ checkoutUrl: paid.order.checkoutUrl });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(h.calls).toHaveLength(3);
    for (const [index, call] of h.calls.entries()) {
      expect([call.method, new URL(call.url).pathname, new URL(call.url).search]).toEqual(['POST', '/v1/orders', '']);
      expect(call.headers.get('authorization')).toBe(index === 0 ? 'Bearer buyer' : 'Bearer explicit');
      expect(call.headers.get('idempotency-key')).toBe(intent.idempotencyKey);
      expect(await call.json()).toEqual({
        offerId: intent.offerId,
        expectedOfferRevision: intent.expectedOfferRevision,
      });
    }
    restrictive(h.calls);
  } finally {
    h.restore();
  }
});

test('Checkout keeps bounded JSON validation, native conflicts and safe URLs without retries or replacement keys', async () => {
  const h = nativeHarness();
  try {
    for (const body of [
      '{',
      '[]',
      JSON.stringify({ ...intent, extra: true }),
      ...[
        { offerId: 'bad' },
        { idempotencyKey: 'bad' },
        { expectedOfferRevision: 0 },
        { expectedOfferRevision: 1.5 },
      ].map((patch) => JSON.stringify({ ...intent, ...patch })),
    ])
      await expect(startCheckout(checkoutRequest(body, true), env)).rejects.toMatchObject({ problem: { status: 400 } });
    await expect(startCheckout(checkoutRequest(' '.repeat(4097), true), env)).rejects.toMatchObject({
      problem: { status: 413 },
    });
    const overLimit = checkoutRequest(undefined, true);
    overLimit.headers.set('content-length', '4097');
    await expect(startCheckout(overLimit, env)).rejects.toMatchObject({ problem: { status: 413 } });
    expect(overLimit.bodyUsed).toBe(false);
    expect(h.calls).toHaveLength(0);
    for (const failure of [
      acquisitionProblems.owned,
      acquisitionProblems.pending,
      { code: 'offer_revision_conflict' },
      { code: 'offer_unavailable' },
    ]) {
      h.native.checkoutStatus = 409;
      h.native.checkout = failure;
      const before = h.calls.length;
      const response = await startCheckout(checkoutRequest(undefined, true), env);
      expect(response.status).toBe(409);
      const body = await response.json();
      if ('orderId' in failure) expect(body).toEqual(failure);
      else expect(body).toMatchObject({ code: failure.code, status: 409 });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(h.calls).toHaveLength(before + 1);
    }
    h.native.checkoutStatus = 200;
    for (const checkoutUrl of ['javascript:alert(1)', '/relative', null]) {
      h.native.checkout = { order: { ...paid.order, checkoutUrl } };
      const before = h.calls.length;
      await expect(startCheckout(checkoutRequest(undefined, true), env)).rejects.toMatchObject({
        problem: { status: 503 },
      });
      expect(h.calls).toHaveLength(before + 1);
    }
    restrictive(h.calls);
    for (const call of h.calls) expect(call.headers.get('idempotency-key')).toBe(intent.idempotencyKey);
  } finally {
    h.restore();
  }
});
