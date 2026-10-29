import { afterAll, expect, mock, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { limitRead, readLimitKey } from '../src/rate-limit/read.ts';
import { newCsrfToken } from '../src/session/csrf.ts';
import { prepareSession } from '../src/session/request.ts';

let kernelOrigin = '';
mock.module('cloudflare:workers', () => ({
  env: {
    get KERNEL_ORIGIN() {
      return kernelOrigin;
    },
  },
}));
let pageRequest: Request | undefined;
mock.module('@tanstack/react-start/server', () => ({
  getRequest() {
    return pageRequest;
  },
  setResponseHeader() {},
}));
mock.module('@tanstack/react-router', () => ({
  notFound() {
    return new Error('Not Found');
  },
}));

const app = join(import.meta.dir, '..');
const contentId = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const targetOfferId = contentId(1);
const idempotencyKey = contentId(2);
const paidOrderId = contentId(10);
const pendingOrderId = contentId(11);
const createdOrderId = contentId(20);
const accessToken = 'access-token';
const csrf = newCsrfToken();
const cookieId = 'a'.repeat(43);
const loginId = 'b'.repeat(43);
const clientIp = '203.0.113.8';
const buyer = 'buyer';
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_checkout';
const keyPair = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(keyPair.privateKey)), alg: 'ES256', kid: 'checkout-cost' };

type KernelCall = {
  method: string;
  path: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: unknown;
};
type Offer = {
  id: string;
  targetSubjectId: string;
  title: string;
  currency: string;
  unitAmountMinor: number;
  state: 'active';
  subject: null;
};
type Order = {
  id: string;
  offerId: string;
  title: string;
  targetSubjectId: string;
  subject: null;
  settlement: 'paid' | 'pending' | 'failed' | 'unknown';
  checkoutUrl: string | null;
  checkoutExpiresAt: string | null;
  entitlementId: string | null;
  createdAt: string;
};
const kernelCalls: KernelCall[] = [];
const authCalls: string[] = [];
let heldOffers: Offer[] = [];
let heldOrders: Order[] = [];

const offerOf = (id: string): Offer => ({
  id,
  targetSubjectId: contentId(90),
  title: id === targetOfferId ? 'A field guide to stars' : `Other offer ${id}`,
  currency: 'usd',
  unitAmountMinor: 123456,
  state: 'active',
  subject: null,
});
const orderOf = (id: string, settlement: Order['settlement'], offerId = targetOfferId): Order => ({
  id,
  offerId,
  title: 'A field guide to stars',
  targetSubjectId: contentId(90),
  subject: null,
  settlement,
  checkoutUrl: settlement === 'failed' ? null : checkoutUrl,
  checkoutExpiresAt: '2026-12-01T00:00:00.000Z',
  entitlementId: settlement === 'paid' ? contentId(80) : null,
  createdAt: '2026-10-01T00:00:00.000Z',
});
function holdCatalogue(s: number) {
  heldOffers = Array.from({ length: s }, (_, n) => offerOf(contentId(1_000 + n)));
  heldOrders = Array.from({ length: s }, (_, n) => orderOf(contentId(2_000 + n), 'paid'));
}
const sequence = (calls: KernelCall[]) => calls.map((call) => `${call.method} ${call.path}`);

async function readBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const text = await request.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const problem = (status: number, code: string) =>
  Response.json(
    {
      type: `https://rezics.com/problems/${code}`,
      title: code,
      status,
      code,
      retryable: status === 503,
      effect_status: 'not_applied',
      request_id: contentId(70),
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    if (url.pathname.startsWith('/auth/')) {
      authCalls.push(`${request.method} ${path}`);
      if (url.pathname === '/auth/.well-known/openid-configuration') {
        const issuer = `${url.origin}/auth`;
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['private_key_jwt'],
          token_endpoint_auth_signing_alg_values_supported: ['ES256'],
        });
      }
      return new Response(null, { status: 200 });
    }
    const body = await readBody(request);
    kernelCalls.push({
      method: request.method,
      path,
      authorization: request.headers.get('authorization'),
      idempotencyKey: request.headers.get('idempotency-key'),
      body,
    });
    if (request.method === 'GET' && url.pathname === '/v1/offers') return Response.json({ offers: heldOffers });
    if (request.method === 'GET' && url.pathname === '/v1/orders') return Response.json({ orders: heldOrders });
    if (url.pathname.includes('search')) return Response.json({ offers: heldOffers, orders: heldOrders });
    const offerId = /^\/v1\/offers\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === 'GET' && offerId) {
      if (offerId !== targetOfferId && !heldOffers.some((offer) => offer.id === offerId))
        return problem(404, 'not_found');
      return Response.json({ offer: offerOf(offerId) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/orders') {
      const requested = typeof body === 'object' && body && 'offerId' in body ? String(body.offerId) : targetOfferId;
      return Response.json(
        { order: orderOf(createdOrderId, 'pending', requested) },
        {
          status: 201,
          headers: { location: `/v1/orders/${createdOrderId}`, 'cache-control': 'no-store' },
        },
      );
    }
    const orderId = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === 'GET' && orderId) {
      if (orderId === paidOrderId) return Response.json({ order: orderOf(paidOrderId, 'paid') });
      if (orderId === pendingOrderId) return Response.json({ order: orderOf(pendingOrderId, 'pending') });
      const other = heldOrders.find((order) => order.id === orderId);
      if (other) return Response.json({ order: other });
      return problem(404, 'not_found');
    }
    return problem(404, 'not_found');
  },
});
kernelOrigin = kernel.url.origin;

const { startCheckout } = await import('../src/checkout/start.ts');
const { loadOrder, orderStatusResponse } = await import('../src/checkout/order.server.ts');

type Counts = { credential: number; signedIn: number; create: number; takeLogin: number; end: number; r2: number };
function sessionHarness() {
  const counts: Counts = { credential: 0, signedIn: 0, create: 0, takeLogin: 0, end: 0, r2: 0 };
  const stub = {
    async credential() {
      counts.credential += 1;
      return { status: 'active' as const, subject: buyer, accessToken, csrfToken: csrf };
    },
    async signedIn() {
      counts.signedIn += 1;
      return { signedIn: true, subject: buyer, csrfToken: csrf };
    },
    async create() {
      counts.create += 1;
    },
    async takeLogin() {
      counts.takeLogin += 1;
      return undefined;
    },
    async end() {
      counts.end += 1;
      return undefined;
    },
  };
  const env = {
    SESSIONS: {
      idFromName(id: string) {
        return id;
      },
      get(_id: string) {
        return stub;
      },
    },
    AUTH_ISSUER: `${kernel.url.origin}/auth`,
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'order:create order:read',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
    SITE_ORIGINS: 'https://site.test',
    MEDIA: {
      get() {
        counts.r2 += 1;
      },
      head() {
        counts.r2 += 1;
      },
      put() {
        counts.r2 += 1;
      },
      delete() {
        counts.r2 += 1;
      },
      list() {
        counts.r2 += 1;
      },
    },
  };
  return { counts, env };
}
const durableCalls = (counts: Counts) =>
  counts.credential + counts.signedIn + counts.create + counts.takeLogin + counts.end;

function checkoutRequest(offerId: string, key: string) {
  return new Request('https://site.test/checkout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `__Host-rezics_session=${cookieId}`,
      origin: 'https://site.test',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ offerId, idempotencyKey: key }),
  });
}
function orderRequest(id: string) {
  return new Request(`https://site.test/orders/${id}/status`, {
    headers: { accept: 'application/json', cookie: `__Host-rezics_session=${cookieId}` },
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: kernel.url.origin,
        AUTH_ISSUER: `${kernel.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'order:create order:read',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await fetch(`${origin}/en/`, { redirect: 'manual' })).status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
      await Bun.sleep(250);
    }
  })();
  return started;
}

afterAll(() => {
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test('checkout start stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    holdCatalogue(s);
    expect(heldOffers).toHaveLength(s);
    expect(heldOrders).toHaveLength(s);
    const warmed = await fetch(`${origin}/en/offers/${targetOfferId}`);
    expect(warmed.status).toBe(200);
    kernelCalls.length = 0;
    authCalls.length = 0;
    const { counts, env } = sessionHarness();
    const response = await startCheckout(checkoutRequest(targetOfferId, idempotencyKey), env);
    expect(response.status).toBe(200);
    expect(counts.credential).toBe(1);
    expect(durableCalls(counts)).toBe(1);
    expect(sequence(kernelCalls)).toEqual(['POST /v1/orders']);
    expect(kernelCalls[0]).toEqual({
      method: 'POST',
      path: '/v1/orders',
      authorization: `Bearer ${accessToken}`,
      idempotencyKey,
      body: { offerId: targetOfferId },
    });
    expect(counts.r2).toBe(0);
    expect(authCalls).toEqual([]);
  }
});

test('order status read stays within its bound as s grows', async () => {
  for (const s of [1, 8, 64]) {
    holdCatalogue(s);
    expect(heldOffers).toHaveLength(s);
    expect(heldOrders).toHaveLength(s);
    for (const [id, settlement] of [
      [paidOrderId, 'paid'],
      [pendingOrderId, 'pending'],
    ] as const) {
      kernelCalls.length = 0;
      authCalls.length = 0;
      const { counts, env } = sessionHarness();
      const request = orderRequest(id);
      await prepareSession(request, env);
      const response = await orderStatusResponse(request, id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, offerId: targetOfferId, settlement });
      expect(counts.credential).toBe(1);
      expect(durableCalls(counts)).toBe(1);
      expect(sequence(kernelCalls)).toEqual([`GET /v1/orders/${id}`]);
      expect(kernelCalls[0]).toMatchObject({
        method: 'GET',
        path: `/v1/orders/${id}`,
        authorization: `Bearer ${accessToken}`,
      });
      expect(counts.r2).toBe(0);
      expect(authCalls).toEqual([]);

      // The page read is the same one call, with the page locale in its query, and the subject summary comes with it.
      kernelCalls.length = 0;
      const page = sessionHarness();
      const pageLoad = orderRequest(id);
      await prepareSession(pageLoad, page.env);
      pageRequest = pageLoad;
      const data = await loadOrder(id, 'de');
      pageRequest = undefined;
      expect(data).toMatchObject({ id, offerId: targetOfferId, settlement, title: 'A field guide to stars' });
      expect(data.subject.subject.title).toBe('A field guide to stars');
      expect(page.counts.credential).toBe(1);
      expect(durableCalls(page.counts)).toBe(1);
      expect(sequence(kernelCalls)).toEqual([`GET /v1/orders/${id}?languages=de`]);
      expect(kernelCalls[0]).toMatchObject({ authorization: `Bearer ${accessToken}` });
      expect(page.counts.r2).toBe(0);
    }
  }
});

type LimitCall = { binding: 'READS_10S' | 'READS_60S'; key: string };
type Traffic = { D: number; K: number; R: number; A: number };
test('read rate limits stay within their bound as s grows', async () => {
  const subject = 'person-7';
  const cases = [
    {
      subject,
      key: `account:${subject}`,
      request: () => new Request('https://site.test/en/offers/' + targetOfferId),
    },
    {
      subject: undefined,
      key: `session:${cookieId}`,
      request: () => new Request('https://site.test/en/', { headers: { cookie: `__Host-rezics_session=${cookieId}` } }),
    },
    {
      subject: undefined,
      key: `session:${loginId}`,
      request: () => new Request('https://site.test/en/', { headers: { cookie: `__Host-rezics_login=${loginId}` } }),
    },
    {
      subject: undefined,
      key: `ip:${clientIp}`,
      request: () => new Request('https://site.test/en/', { headers: { 'cf-connecting-ip': clientIp } }),
    },
  ];
  for (const s of [1, 8, 64]) {
    for (const item of cases) {
      const measured = await measureRead(s);
      const request = item.request();
      const response = await limitRead(request, measured.env, readLimitKey(request, item.subject));
      expect(response).toBeUndefined();
      expect(measured.calls).toEqual([
        { binding: 'READS_10S', key: item.key },
        { binding: 'READS_60S', key: item.key },
      ]);
      expect(measured.keys.size).toBe(s + 1);
      expect(measured.traffic).toEqual({ D: 0, K: 0, R: 0, A: 0 });
      expect(measured.http).toEqual([]);
      measured.restore();
    }
    const refused = await measureRead(s, `ip:${clientIp}`);
    const request = new Request('https://site.test/en/', { headers: { 'cf-connecting-ip': clientIp } });
    const response = await limitRead(request, refused.env, readLimitKey(request));
    expect(response?.status).toBe(429);
    expect(response?.headers.get('retry-after')).toBe('10');
    await response?.arrayBuffer();
    expect(refused.calls).toEqual([
      { binding: 'READS_10S', key: `ip:${clientIp}` },
      { binding: 'READS_60S', key: `ip:${clientIp}` },
    ]);
    expect(refused.keys.size).toBe(s + 1);
    expect(refused.traffic).toEqual({ D: 0, K: 0, R: 0, A: 0 });
    expect(refused.http).toEqual([]);
    refused.restore();
  }
});

function measureRead(s: number, refuseKey?: string) {
  const calls: LimitCall[] = [];
  const keys = new Set<string>();
  const traffic: Traffic = { D: 0, K: 0, R: 0, A: 0 };
  const http: string[] = [];
  const limit = (binding: LimitCall['binding']) => ({
    limit(options: { key: string }) {
      calls.push({ binding, key: options.key });
      keys.add(options.key);
      return Promise.resolve({ success: options.key !== refuseKey });
    },
  });
  for (let n = 0; n < s; n += 1) {
    const key = `account:other-${n}`;
    limit('READS_10S').limit({ key });
    limit('READS_60S').limit({ key });
  }
  calls.length = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    http.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname.startsWith('/auth')) traffic.A += 1;
    else traffic.K += 1;
    return previous(input, init);
  }) as typeof fetch;
  const touch = (kind: 'D' | 'R') => () => {
    traffic[kind] += 1;
  };
  const env = {
    READS_10S: limit('READS_10S'),
    READS_60S: limit('READS_60S'),
    SESSIONS: { idFromName: touch('D'), get: touch('D') },
    MEDIA: { get: touch('R'), head: touch('R'), put: touch('R'), delete: touch('R'), list: touch('R') },
  };
  return { calls, keys, traffic, http, env, restore: () => (globalThis.fetch = previous) };
}

test('offer page stays within its bound as s grows', async () => {
  const origin = await site();
  // The development Worker hides its workerd-bound SESSIONS binding, so its page D count is derived from the route.
  for (const s of [1, 8, 64]) {
    holdCatalogue(s);
    expect(heldOffers).toHaveLength(s);
    expect(heldOrders).toHaveLength(s);
    kernelCalls.length = 0;
    authCalls.length = 0;
    const response = await fetch(`${origin}/en/offers/${targetOfferId}`);
    const body = await response.text();
    expect(response.status, body.slice(0, 500)).toBe(200);
    expect(sequence(kernelCalls)).toEqual([`GET /v1/offers/${targetOfferId}?languages=en`]);
    expect(kernelCalls[0]).toMatchObject({
      method: 'GET',
      path: `/v1/offers/${targetOfferId}?languages=en`,
      authorization: null,
    });
    expect(authCalls).toEqual([]);
  }
}, 300_000);
