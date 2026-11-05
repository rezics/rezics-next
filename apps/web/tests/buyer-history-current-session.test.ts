import { expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import type { BuyerOrder } from '../src/checkout/orders';
import type { BuyerEntitlement } from '../src/checkout/entitlements';
import {
  activeEntitlement,
  fixedEditionTerms,
  mappedEntitlement,
  revokedEntitlement,
} from '../src/kernel/fake/entitlements';
import paid from '../src/kernel/recorded/order-paid.json';
import { newCsrfToken } from '../src/session/csrf';
import { viewerCredential } from '../src/session/request';

const origin = 'https://site.test';
const cookie = `__Host-rezics_session=${'a'.repeat(43)}`;
const csrfToken = newCsrfToken();
let status: 'active' | 'absent' | 'unavailable' = 'active';
let accessToken = 'cached-buyer';
let preparations = 0;
let request: Request;
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid order:read entitlement:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SITE_ORIGINS: origin,
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          return status === 'active' ? { status, accessToken, subject: 'buyer', csrfToken } : { status, csrfToken };
        },
      }),
    },
  },
}));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { readBuyerOrders } = await import('../src/checkout/orders');
const { readBuyerEntitlements, readBuyerEntitlement } = await import('../src/checkout/entitlements');

// Constructed wire inputs exercise the ordinary BFF and generated transport, not native sale/use authority.
const order: BuyerOrder = {
  ...paid.order,
  settlement: 'paid',
  offerRevision: 1,
  currency: 'usd',
  unitAmountMinor: 1200,
  moneyUnit: null,
  taxBehavior: null,
  taxCode: 'txcd_10302000',
  amountTaxMinor: null,
  contentEdition: mappedEntitlement.contentEdition,
};
const records: BuyerEntitlement[] = [
  mappedEntitlement,
  { ...revokedEntitlement, id: '0192f3a0-6c1e-7b2a-9d4e-000000000091' },
  { ...revokedEntitlement, id: '0192f3a0-6c1e-7b2a-9d4e-000000000092', revokeReason: 'dispute' },
  { ...activeEntitlement, id: '0192f3a0-6c1e-7b2a-9d4e-000000000093', summary: null },
];
const orders = (cursor?: string) => readBuyerOrders({ data: cursor ? { cursor } : {} });
const entitlements = (cursor?: string) =>
  readBuyerEntitlements({ data: { locale: 'en', ...(cursor ? { cursor } : {}) } });
const entitlement = () => readBuyerEntitlement({ data: { locale: 'en', id: mappedEntitlement.id } });
const readers = [orders, entitlements, entitlement];
function newRequest(method = 'GET', headers?: HeadersInit): Request {
  return new Request(`${origin}/en/entitlements?accountId=another-buyer`, {
    method,
    headers: headers ?? { cookie, origin, 'x-csrf-token': csrfToken },
  });
}
function reset(): void {
  request = newRequest();
  status = 'active';
  accessToken = 'cached-buyer';
  preparations = 0;
  responseHeaders.delete('cache-control');
}

test('buyer history refuses an actually stale prepared Request before private or enrichment IO and preserves preparation failures', async () => {
  reset();
  const calls: Request[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json({ orders: [order], next: null });
  });
  try {
    expect(await orders()).toEqual({ orders: [order], next: null });
    expect(viewerCredential(request)).toBe('Bearer cached-buyer');
    calls.length = 0;
    status = 'absent';
    await expect(orders()).rejects.toMatchObject({ isNotFound: true });
    expect(await entitlements()).toEqual({ kind: 'denied' });
    expect(await entitlement()).toEqual({ kind: 'denied' });
    expect(preparations).toBe(4);
    // The shared policy intentionally retains its WeakMap; each reader must honor this preparation's refusal.
    expect(viewerCredential(request)).toBe('Bearer cached-buyer');

    status = 'unavailable';
    for (const read of readers)
      await expect(read()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    expect(calls).toHaveLength(0);

    status = 'active';
    request = newRequest('POST');
    await orders();
    calls.length = 0;
    status = 'absent';
    for (const read of readers)
      await expect(read()).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    status = 'active';
    for (const { header, value } of [
      { header: 'origin', value: 'https://other.test' },
      { header: 'x-csrf-token', value: 'invalid' },
    ]) {
      request = newRequest('POST');
      request.headers.set(header, value);
      for (const read of readers)
        await expect(read()).rejects.toMatchObject({ problem: { status: 403, code: 'forbidden' } });
    }
    expect(calls).toHaveLength(0);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});

test('current-session and explicit credentials preserve owner-self page20 cursors, exact detail identity and restrictive transport', async () => {
  reset();
  const calls: Request[] = [];
  const cursor = 'signed/current+cursor=';
  const next = 'native/exact+next=';
  let point = mappedEntitlement;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path === '/v1/orders') return Response.json({ orders: [order], next });
    if (path === '/v1/entitlements') return Response.json({ entitlements: records, next });
    if (path === `/v1/entitlements/${mappedEntitlement.id}`) return Response.json({ entitlement: point });
    if (path === '/v1/accounts')
      return Response.json({
        accounts: [{ id: fixedEditionTerms.creatorAccountId, displayName: 'Captured creator', state: 'active' }],
      });
    throw new Error(`Unexpected buyer history request: ${call.method} ${path}`);
  });
  try {
    await orders();
    accessToken = 'current-buyer';
    const modes: (HeadersInit | undefined)[] = [
      undefined,
      { authorization: 'Bearer explicit-buyer' },
      { cookie, authorization: 'Bearer explicit-buyer' },
    ];
    for (const headers of modes) {
      if (headers) {
        status = 'absent';
        request = newRequest('GET', headers);
      }
      const before = preparations;
      calls.length = 0;
      expect(await orders(cursor)).toEqual({ orders: [order], next });
      expect(await entitlements(cursor)).toEqual({ kind: 'ready', data: { entitlements: records, next } });
      expect(await entitlement()).toEqual({ kind: 'ready', data: point, creatorName: 'Captured creator' });
      expect(preparations - before).toBe(headers ? 0 : 3);
      expect(
        calls.map((call) => [new URL(call.url).pathname, Object.fromEntries(new URL(call.url).searchParams)]),
      ).toEqual([
        ['/v1/orders', { limit: '20', cursor }],
        ['/v1/entitlements', { limit: '20', cursor }],
        [`/v1/entitlements/${mappedEntitlement.id}`, {}],
        ['/v1/accounts', { ids: fixedEditionTerms.creatorAccountId }],
      ]);
      const privateReads = calls.slice(0, 3);
      expect(
        privateReads.every((call) => call.method === 'GET' && call.cache === 'no-store' && call.redirect === 'manual'),
      ).toBe(true);
      expect(privateReads.map((call) => call.headers.get('authorization'))).toEqual(
        Array(3).fill(headers ? 'Bearer explicit-buyer' : 'Bearer current-buyer'),
      );
      expect(calls[3]!.headers.has('authorization')).toBe(false);
      expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    }

    // Identity mismatch is unavailable before creator enrichment; historical unknown mapping stays unknown.
    point = { ...mappedEntitlement, id: records[1]!.id };
    calls.length = 0;
    expect(await entitlement()).toEqual({ kind: 'unavailable' });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([`/v1/entitlements/${mappedEntitlement.id}`]);
    point = activeEntitlement;
    calls.length = 0;
    expect(await entitlement()).toEqual({ kind: 'ready', data: activeEntitlement });
    expect(calls).toHaveLength(1);
  } finally {
    transport.mockRestore();
  }
});
